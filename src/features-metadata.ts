import type { Express, Request, Response } from 'express';
import { readFile } from 'node:fs/promises';
import { stringify } from 'yaml';
import { page } from './account-pages.js';
import type { Publication } from './config.js';
import { publicationAccess, type PublicationReader } from './publication-access.js';
import { probeHealth, type HealthEndpoint } from './publication-health.js';

interface Catalog {
  collections: { id: string; title: string; description?: string; status?: 'available' | 'unavailable' }[];
}

interface LinkedCatalog {
  dataset: { '@id': string }[];
}

interface ManagedMetadata {
  url: string;
  api: OpenApi;
  collections: Catalog['collections'];
  conformsTo?: string[];
  conformance?: { common: string[]; publications: Record<string, string[]> };
  tileCatalog?: Record<string, { name: string; description: string; content_type: string; tilejson: string }>;
  sourceProbes?: Record<string, HealthEndpoint>;
}

export async function readManagedMetadata() {
  return JSON.parse(await readFile('/etc/gis/features.json', 'utf8')) as Record<string, ManagedMetadata>;
}

interface OpenApiOperation {
  security?: Record<string, string[]>[];
  responses: Record<string, unknown>;
}

interface OpenApi {
  openapi?: string;
  paths: Record<string, { get?: OpenApiOperation; post?: OpenApiOperation }>;
  tags?: { name: string }[];
  info?: { title: string };
  components: {
    parameters?: { resourceId?: { schema?: { default?: string } } };
    securitySchemes?: Record<string, unknown>;
  };
}

const errors = {
  401: ['Unauthorized', 'An active session or a valid Bearer token is required.'],
  403: ['Forbidden', 'This account cannot access this resource.'],
  503: ['ServiceUnavailable', 'Access or publication is temporarily unavailable.'],
} as const;

export function featuresError(res: Response, status: keyof typeof errors) {
  const [code, description] = errors[status];
  if (status === 401) res.set('WWW-Authenticate', 'Session realm="GIS Platform", Bearer realm="GIS Platform"');
  res.status(status).json({ code, description });
}

function canRead(publications: Map<string, Publication['access']>, id: string, reader: PublicationReader | null) {
  const mode = publications.get(id);
  return mode !== undefined && publicationAccess(mode, id, reader) === 200;
}

function annotateOpenApi(api: OpenApi, publications: Map<string, Publication['access']>, reader: PublicationReader | null,
  cookieName: string, directTiles = false) {
  let hasProtectedPaths = false;
  const metadataPaths = ['/', '/openapi', '/conformance', ...(directTiles ? ['/catalog'] :
    ['/collections', '/TileMatrixSets', '/TileMatrixSets/{tileMatrixSetId}'])];
  api.paths = Object.fromEntries(Object.entries(api.paths).filter(([path, entry]) => {
    if (metadataPaths.includes(path)) return true;
    const id = (directTiles ? /^\/([^/]+)(?:\/|$)/ : /^\/collections\/([^/]+)(?:\/|$)/).exec(path)?.[1];
    if (!id || !canRead(publications, id, reader)) return false;
    if (publications.get(id) === 'public') return true;
    hasProtectedPaths = true;
    for (const operation of [entry.get, entry.post]) {
      if (!operation) continue;
      operation.security = [{ session: [] }, { bearer: [] }];
      for (const [status, [code, description]] of Object.entries(errors)) {
        operation.responses[status] = {
          description,
          ...(status === '401' && { headers: { 'WWW-Authenticate': { schema: { type: 'string' } } } }),
          content: { 'application/json': { schema: { type: 'object', required: ['code'], properties: {
            code: { type: 'string', enum: [code] }, description: { type: 'string' },
          } } } },
        };
      }
    }
    return true;
  }));
  // pygeoapi lists the generic server tag first, followed by one tag per collection.
  api.tags = api.tags?.filter(({ name }, index) => (index === 0 && name === 'server') || canRead(publications, name, reader));
  const resourceId = api.components.parameters?.resourceId?.schema;
  if (resourceId?.default && !canRead(publications, resourceId.default, reader)) delete resourceId.default;
  if (hasProtectedPaths) {
    const schemes = api.components.securitySchemes ??= {};
    schemes.session = { type: 'apiKey', in: 'cookie', name: cookieName };
    schemes.bearer = { type: 'http', scheme: 'bearer' };
  }
}

async function upstreamDocument<T>(name: 'openapi' | 'collections', format: 'json' | 'jsonld' = 'json') {
  const res = await fetch(`http://pygeoapi:80/${name}?f=${format}`, {
    redirect: 'error', signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) {
    await res.body?.cancel();
    throw new Error(`Features ${name} is unavailable.`);
  }
  return await res.json() as T;
}

function escapeHtml(value: string) {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

const mediaTypes = { json: 'application/json', html: 'text/html', jsonld: 'application/ld+json', yaml: 'application/yaml' };

function requestedFormat(req: Request, supported: (keyof typeof mediaTypes)[]) {
  if (req.query.f !== undefined) return supported.find((name) => name === req.query.f);
  const type = req.accepts(supported.map((name) => mediaTypes[name]));
  return supported.find((name) => mediaTypes[name] === type) ?? 'json';
}

export function mountFeaturesMetadata(app: Express, modes: Record<string, Publication['access']>, cookieName: string,
  readReader: (req: Request, res: Response) => Promise<PublicationReader | null>,
  managed?: Record<string, ManagedMetadata>) {
  for (const [root, metadata] of Object.entries(managed ?? { '/features': undefined })) {
    mountRoot(app, modes, cookieName, readReader, root, metadata);
  }
}

function mountRoot(app: Express, modes: Record<string, Publication['access']>, cookieName: string,
  readReader: (req: Request, res: Response) => Promise<PublicationReader | null>, root: string, metadata?: ManagedMetadata) {
  const publications = new Map(Object.entries(modes));
  const title = metadata?.api.info?.title ?? 'Features';
  const tiles = metadata?.tileCatalog;
  if (tiles) {
    app.get(root, (_req, res) => res.json({ title, links: [
      { rel: 'self', href: metadata.url, type: mediaTypes.json },
      { rel: 'data', href: `${metadata.url}/catalog`, type: mediaTypes.json },
      { rel: 'service-desc', href: `${metadata.url}/openapi`, type: 'application/vnd.oai.openapi+json;version=3.0' },
      { rel: 'conformance', href: `${metadata.url}/conformance`, type: mediaTypes.json },
    ] }));
    app.get(`${root}/catalog`, async (req, res) => {
      res.vary('Cookie').vary('Authorization');
      const reader = await readReader(req, res);
      res.json({ tiles: Object.fromEntries(Object.entries(tiles).filter(([id]) => canRead(publications, id, reader))) });
    });
    app.get(`${root}/conformance`, async (req, res) => {
      res.vary('Cookie').vary('Authorization');
      const reader = await readReader(req, res);
      res.json({ interfaces: Object.keys(tiles).some((id) => canRead(publications, id, reader)) ? ['TileJSON', 'XYZ'] : [] });
    });
  }
  if (metadata?.api.openapi?.startsWith('3.1.')) app.get(root, (_req, res) => {
    res.json({
      title,
      links: [
        { rel: 'self', href: metadata.url, type: mediaTypes.json },
        { rel: 'data', href: `${metadata.url}/collections`, type: mediaTypes.json },
        { rel: 'service-desc', href: `${metadata.url}/openapi`, type: 'application/vnd.oai.openapi+json;version=3.1' },
        { rel: 'service-doc', href: `${metadata.url}/docs`, type: mediaTypes.html },
      ],
    });
  });
  const conformance = metadata?.conformance;
  if (conformance || metadata?.conformsTo) app.get(`${root}/conformance`, async (req, res) => {
    const representation = requestedFormat(req, ['json', 'html']);
    if (!representation) return res.status(400).json({ code: 'InvalidParameterValue', description: 'Invalid format.' });
    res.vary('Accept');
    let conformsTo = metadata.conformsTo ?? [];
    if (conformance) {
      res.vary('Cookie').vary('Authorization');
      const reader = await readReader(req, res);
      conformsTo = [...new Set([...conformance.common, ...Object.entries(conformance.publications)
        .filter(([id]) => canRead(publications, id, reader)).flatMap(([, classes]) => classes)])].sort();
    }
    if (representation === 'html') return res.send(page(`${title} conformance`,
      `<ul>${conformsTo.map((uri) => `<li>${escapeHtml(uri)}</li>`).join('')}</ul>`, false, root));
    res.json({ conformsTo });
  });
  app.use([`${root}/openapi`, `${root}/collections`], (_req, res, next) => {
    res.vary('Cookie').vary('Authorization').vary('Accept');
    next();
  });
  app.get(`${root}/collections`, async (req, res) => {
    const representation = requestedFormat(req, ['json', 'html', 'jsonld']);
    if (!representation) return res.status(400).json({ code: 'InvalidParameterValue', description: 'Invalid format.' });
    const reader = await readReader(req, res);
    const visible = async (collections: Catalog['collections']) => Promise.all(
      collections.filter(({ id }) => canRead(publications, id, reader)).map(async (collection) => {
        const probe = metadata?.sourceProbes?.[collection.id];
        if (!probe) return collection;
        return { ...collection, status: await probeHealth(probe) ? 'available' as const : 'unavailable' as const };
      }));
    if (representation === 'jsonld') {
      if (metadata) return res.type(mediaTypes.jsonld).json({
        '@context': { '@vocab': 'https://schema.org/' },
        '@type': 'DataCatalog',
        dataset: (await visible(metadata.collections))
          .map(({ id, title, description, status }) => ({
            '@id': `${metadata.url}/collections/${id}`, '@type': 'Dataset', name: title, description, status,
          })),
      });
      const catalog = await upstreamDocument<LinkedCatalog>('collections', 'jsonld');
      catalog.dataset = catalog.dataset.filter(({ '@id': url }) => {
        const id = /^\/features\/collections\/([^/]+)$/.exec(new URL(url).pathname)?.[1];
        return id !== undefined && canRead(publications, id, reader);
      });
      return res.type(mediaTypes.jsonld).json(catalog);
    }
    const catalog = metadata ? {
      collections: metadata.collections,
      links: ['json', 'html', 'jsonld'].map((format) => ({
        href: `${metadata.url}/collections?f=${format}`, rel: format === representation ? 'self' : 'alternate',
        type: mediaTypes[format as keyof typeof mediaTypes],
      })),
    } : await upstreamDocument<Catalog>('collections');
    catalog.collections = await visible(catalog.collections);
    if (representation === 'html') {
      const rows = catalog.collections.map(({ id, title, description, status }) =>
        `<li><a href="${root}/collections/${encodeURIComponent(id)}?f=html">${escapeHtml(title)}</a>` +
        `${status === 'unavailable' ? ' <span>Unavailable</span>' : ''}${description ? `<p>${escapeHtml(description)}</p>` : ''}</li>`);
      return res.send(page(`${title} collections`, rows.length ? `<ul>${rows.join('')}</ul>` : '<p>No collections available.</p>', false, root));
    }
    res.json(catalog);
  });
  app.get(`${root}/openapi`, async (req, res) => {
    const representation = requestedFormat(req, ['json', 'html', 'yaml']);
    if (!representation) return res.status(400).json({ code: 'InvalidParameterValue', description: 'Invalid format.' });
    const reader = await readReader(req, res);
    const api = metadata ? structuredClone(metadata.api) : await upstreamDocument<OpenApi>('openapi');
    annotateOpenApi(api, publications, reader, cookieName, Boolean(tiles));
    if (representation === 'yaml') return res.type('application/yaml').send(stringify(api));
    if (representation === 'html') {
      return res.send(page(`${title} OpenAPI`, `<p><a href="${root}/openapi?f=json">OpenAPI JSON</a></p>` +
        `<pre>${escapeHtml(JSON.stringify(api, null, 2))}</pre>`, false, root));
    }
    res.type(`application/vnd.oai.openapi+json;version=${api.openapi?.startsWith('3.1.') ? '3.1' : '3.0'}`).json(api);
  });
}
