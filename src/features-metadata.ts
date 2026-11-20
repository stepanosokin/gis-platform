import type { Express, Request, Response } from 'express';
import { stringify } from 'yaml';
import { page } from './account-pages.js';
import type { Publication } from './config.js';
import { publicationAccess, type PublicationReader } from './publication-access.js';

interface Catalog {
  collections: { id: string; title: string; description?: string }[];
}

interface LinkedCatalog {
  dataset: { '@id': string }[];
}

interface OpenApi {
  paths: Record<string, { get?: { security?: { session: string[] }[]; responses: Record<string, unknown> } }>;
  tags?: { name: string }[];
  components: {
    parameters?: { resourceId?: { schema?: { default?: string } } };
    securitySchemes?: Record<string, unknown>;
  };
}

const errors = {
  401: ['Unauthorized', 'An active session is required.'],
  403: ['Forbidden', 'This account cannot access this resource.'],
  503: ['ServiceUnavailable', 'Access or publication is temporarily unavailable.'],
} as const;

export function featuresError(res: Response, status: keyof typeof errors) {
  const [code, description] = errors[status];
  if (status === 401) res.set('WWW-Authenticate', 'Session realm="GIS Platform"');
  res.status(status).json({ code, description });
}

function canRead(publications: Map<string, Publication['access']>, id: string, reader: PublicationReader | null) {
  const mode = publications.get(id);
  return mode !== undefined && publicationAccess(mode, id, reader) === 200;
}

function annotateOpenApi(api: OpenApi, publications: Map<string, Publication['access']>, reader: PublicationReader | null, cookieName: string) {
  let hasProtectedPaths = false;
  api.paths = Object.fromEntries(Object.entries(api.paths).filter(([path, entry]) => {
    if (['/', '/openapi', '/conformance', '/collections'].includes(path)) return true;
    const id = /^\/collections\/([^/]+)(?:\/|$)/.exec(path)?.[1];
    if (!id || !canRead(publications, id, reader)) return false;
    if (publications.get(id) === 'public') return true;
    hasProtectedPaths = true;
    if (entry.get) {
      entry.get.security = [{ session: [] }];
      for (const [status, [code, description]] of Object.entries(errors)) {
        entry.get.responses[status] = {
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
  if (hasProtectedPaths) (api.components.securitySchemes ??= {}).session = { type: 'apiKey', in: 'cookie', name: cookieName };
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
  readReader: (req: Request) => Promise<PublicationReader | null>) {
  const publications = new Map(Object.entries(modes));
  app.use(['/features/openapi', '/features/collections'], (_req, res, next) => {
    res.vary('Cookie').vary('Accept');
    next();
  });
  app.get('/features/collections', async (req, res) => {
    const representation = requestedFormat(req, ['json', 'html', 'jsonld']);
    if (!representation) return res.status(400).json({ code: 'InvalidParameterValue', description: 'Invalid format.' });
    const reader = await readReader(req);
    if (representation === 'jsonld') {
      const catalog = await upstreamDocument<LinkedCatalog>('collections', 'jsonld');
      catalog.dataset = catalog.dataset.filter(({ '@id': url }) => {
        const id = /^\/features\/collections\/([^/]+)$/.exec(new URL(url).pathname)?.[1];
        return id !== undefined && canRead(publications, id, reader);
      });
      return res.type(mediaTypes.jsonld).json(catalog);
    }
    const catalog = await upstreamDocument<Catalog>('collections');
    catalog.collections = catalog.collections.filter(({ id }) => canRead(publications, id, reader));
    if (representation === 'html') {
      const rows = catalog.collections.map(({ id, title, description }) =>
        `<li><a href="/features/collections/${encodeURIComponent(id)}?f=html">${escapeHtml(title)}</a>${description ? `<p>${escapeHtml(description)}</p>` : ''}</li>`);
      return res.send(page('Features collections', rows.length ? `<ul>${rows.join('')}</ul>` : '<p>No collections available.</p>'));
    }
    res.json(catalog);
  });
  app.get('/features/openapi', async (req, res) => {
    const representation = requestedFormat(req, ['json', 'html', 'yaml']);
    if (!representation) return res.status(400).json({ code: 'InvalidParameterValue', description: 'Invalid format.' });
    const reader = await readReader(req);
    const api = await upstreamDocument<OpenApi>('openapi');
    annotateOpenApi(api, publications, reader, cookieName);
    if (representation === 'yaml') return res.type('application/yaml').send(stringify(api));
    if (representation === 'html') {
      return res.send(page('Features OpenAPI', '<p><a href="/features/openapi?f=json">OpenAPI JSON</a></p>' +
        `<pre>${escapeHtml(JSON.stringify(api, null, 2))}</pre>`));
    }
    res.type('application/vnd.oai.openapi+json;version=3.0').json(api);
  });
}
