import { execFile } from 'node:child_process';
import { createHash, X509Certificate } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { get as getHttp } from 'node:http';
import { get as getHttps } from 'node:https';
import { isIP } from 'node:net';
import { basename, extname, join } from 'node:path';
import { text } from 'node:stream/consumers';
import { setTimeout } from 'node:timers/promises';
import { checkServerIdentity, createSecureContext } from 'node:tls';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { parse, stringify } from 'yaml';
import { mapBboxDescription, mapRelation, mapSize } from './maps-profile.js';
import { checkTileJson, martinConfig, martinService, runMartin, tileArchivePath } from './martin-profile.js';
import { matrixSet, tilesRoutes, tilesRelation, tilesSource, vectorTileType } from './tiles-profile.js';
import { mapLibreAssetRoute } from './maplibre-style.js';
import { healthUrl, providerServiceName as serviceName, publicationChecks, publicationHealth } from './publication-health.js';
import { builtInProviderId, hasGeoJson, managedProviderRuns, needsMetadataService, pinnedImage, postgisSource, providerRoot, publicationEntries, publicationsForProvider, publicationUrl,
  crs84, rasterFile, tileArchive, usedFileSources, vectorFile, type FeaturesConfig, type FileSource, type Publication } from './config.js';

const run = promisify(execFile);
const composeFile = (name: string) => fileURLToPath(new URL(`../${name}`, import.meta.url));
const postgisPlugin = 'gis_postgis.PostGISProvider';
const vectorFilePlugin = 'gis_vector_files.VectorFileProvider';
const parquetImage = 'gis-platform-pygeoapi-parquet:0.24.0-arrow-23.0.1';
const apiNames: Partial<Record<Publication['protocol'], string>> = { maps: 'Maps', tiles: 'Tiles' };
let project: string | undefined;

export async function resolveComposeProject() {
  const { stdout } = await run('docker', ['compose', '-f', composeFile('compose.yaml'), 'config', '--format', 'json'],
    { windowsHide: true });
  const config = JSON.parse(stdout) as { name?: string };
  if (!config.name) throw new Error('Compose did not report a project name.');
  project = config.name;
  return project;
}

function pygeoapiConfig(config: FeaturesConfig, instance = builtInProviderId(config)) {
  const publicUrl = instance ? new URL(providerRoot(config, instance), config.publicUrl).href : config.publicUrl;
  const provider = instance ? config.providers?.[instance] : undefined;
  const protocol = provider?.image ? apiNames[provider.api.protocol] ?? 'Features' : 'Features';
  return {
    server: {
      bind: { host: '0.0.0.0', port: provider?.image ? provider.api.port : 80 },
      url: publicUrl,
      mimetype: 'application/json; charset=UTF-8',
      encoding: 'utf-8',
      languages: ['en-US'],
      limits: { default_items: 20, max_items: 100 },
      map: {
        url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap contributors</a>',
      },
      admin: false,
    },
    logging: { level: 'INFO' },
    metadata: {
      identification: {
        title: `GIS Platform ${protocol}`,
        description: `OGC API ${protocol} collections`,
        keywords: [protocol.toLowerCase(), 'geospatial'],
        terms_of_service: publicUrl,
        url: publicUrl,
      },
      license: { name: 'Data license unspecified', url: publicUrl },
      provider: { name: 'GIS Platform', url: publicUrl },
      contact: { name: 'GIS Platform', url: publicUrl },
    },
    resources: Object.fromEntries(publicationEntries(config).filter(([, publication]) =>
      publication.provider === instance).map(([id, publication]) => [id, {
        type: 'collection',
        title: publication.title,
        description: publicationDescription(config, publication),
        keywords: [],
        links: [],
        extents: {
          spatial: { bbox: publication.extent, crs: crs84 },
          ...(publication.time_field && { temporal: { begin: null, end: null } }),
        },
        providers: [publication.protocol === 'tiles' ? tilesSource(config, publication, id) : pygeoapiSource(config, publication)],
    }])),
  };
}

function publicationDescription(config: FeaturesConfig, publication: Publication) {
  if (!vectorFile(config, publication.source)) return publication.description;
  const datetime = publication.time_field ? 'datetime is supported.' : 'datetime is unavailable.';
  return `${publication.description} Filters: bbox and attribute equality are supported. ${datetime} CQL2 is unavailable.`;
}

function pygeoapiSource(config: FeaturesConfig, publication: Publication) {
  const raster = rasterFile(config, publication.source);
  if (raster) return {
    type: 'map', name: 'MapScript', data: sourceMountPath(publication.source, 'raster.tif'),
    options: { type: 'MS_LAYER_RASTER', projection: raster.epsg, cog: raster.type === 'cog' },
    format: { name: 'png', mimetype: 'image/png' },
  };
  const file = vectorFile(config, publication.source);
  if (file) return {
    type: 'feature', name: vectorFilePlugin, id_field: file.id_field, time_field: publication.time_field,
    crs: publication.crs,
    ...(file.type !== 'geoparquet' && { layer: file.layer }),
    data: { path: sourceMountPath(publication.source, basename(file.path)),
      driver: { geopackage: 'GPKG', shapefile: 'ESRI Shapefile', geoparquet: 'Parquet' }[file.type] },
  };
  const source = postgisSource(config, publication.source);
  if (!source) return { type: 'feature', name: 'GeoJSON', data: '/source/data.geojson', id_field: 'id', crs: publication.crs };
  const connection = config.providers?.[publication.provider]?.postgis;
  if (!connection) throw new Error('The PostGIS connection is missing.');
  const { host, port, database, user } = connection;
  return {
    type: 'feature',
    name: postgisPlugin,
    data: { host, port, dbname: database, user, search_path: [source.schema] },
    table: source.relation,
    id_field: source.id_field,
    geom_field: source.geometry_field,
    time_field: publication.time_field,
    crs: publication.crs,
    options: { connect_timeout: 3, options: '-c default_transaction_read_only=on' },
  };
}

export function providerConfigurationChanged(candidate: FeaturesConfig, previous: FeaturesConfig | null,
  id = builtInProviderId(candidate)) {
  if (!previous) return true;
  if (id !== undefined && JSON.stringify(usedFileSources(candidate, id)) !== JSON.stringify(usedFileSources(previous, id))) {
    return true;
  }
  if (id && candidate.providers?.[id]?.type === 'martin') {
    return JSON.stringify(martinConfig(candidate, id)) !== JSON.stringify(martinConfig(previous, id)) ||
      JSON.stringify(candidate.providers[id].postgis) !== JSON.stringify(previous.providers?.[id]?.postgis);
  }
  return (id !== undefined && (
    ((hasGeoJson(candidate, id) || hasGeoJson(previous, id)) && candidate.sourcePath !== previous.sourcePath) ||
    candidate.providers?.[id]?.postgis?.password_file !== previous.providers?.[id]?.postgis?.password_file)) ||
    JSON.stringify(pygeoapiConfig(candidate, id)) !== JSON.stringify(pygeoapiConfig(previous, id));
}

function caddyConfig(config: FeaturesConfig) {
  const site = config.tls ? `https://${new URL(config.publicUrl).hostname}:443` : ':80';
  const tlsOptions = config.tls ? '\n\tauto_https disable_redirects' : '';
  const certificate = config.tls ? '\n\ttls /run/secrets/tls_cert /run/secrets/tls_key' : '';
  const publications = publicationEntries(config);
  const protectedIds = publications.filter(([, publication]) => publication.access !== 'public').map(([id]) => id);
  const publicIds = publications.filter(([, publication]) => publication.access === 'public').map(([id]) => id);
  const ogcRoutes = { maps: 'map', features: 'schema|queryables|items(/.+)?', tiles: tilesRoutes };
  const collectionRoute = (ids: string[], protocol?: Publication['protocol']) =>
    protocol === 'mvt' ? `(${ids.join('|')})(/[0-9]{1,2}/[0-9]{1,10}/[0-9]{1,10})?` :
    `collections/(${ids.join('|')})(/(${protocol ? ogcRoutes[protocol] : Object.values(ogcRoutes).join('|')}))?`;
  const ogcIds = publications.filter(([, publication]) => publication.protocol !== 'mvt').map(([id]) => id);
  const mvtIds = publications.filter(([, publication]) => publication.protocol === 'mvt').map(([id]) => id);
  const allCollections = ogcIds.length ? collectionRoute(ogcIds) : '';
  const allTiles = mvtIds.length ? `/mvt/${collectionRoute(mvtIds, 'mvt')}` : '';
  const styledIds = publications.filter(([, publication]) => publication.maplibre).map(([id]) => id);
  const mapLibreAssets = styledIds.length ? `/mvt/(${styledIds.join('|')})/${mapLibreAssetRoute}` : '';
  const mapRoutes = [allTiles, mapLibreAssets].filter(Boolean).join('|');
  const roots = config.providers ? [...new Set(Object.keys(config.providers).map((id) => providerRoot(config, id)))] : ['/features'];
  const rootPattern = roots.length ? `(?:${roots.join('|')})` : '/features';
  const loggedRoutes = `${rootPattern}/(${['openapi', 'collections', ...(allCollections ? [allCollections] : [])].join('|')})`;
  const logged = [loggedRoutes, mapRoutes].filter(Boolean).join('|');
  const journal = `
	log
	@loggedFeatures path_regexp ^(?:${logged})$
	@unloggedFeatures not path_regexp ^(?:${logged})$
	log_skip @unloggedFeatures
	log_append @loggedFeatures requestId {http.request.uuid}${allCollections ? `
	@loggedPublication path_regexp loggedPublication ^${rootPattern}/${allCollections}$
	log_append @loggedPublication publicationId {http.regexp.loggedPublication.1}` : ''}
	${allTiles ? `@loggedMvt path_regexp loggedMvt ^${allTiles}$
	log_append @loggedMvt publicationId {http.regexp.loggedMvt.1}` : ''}
  ${mapLibreAssets ? `@loggedMapLibre path_regexp loggedMapLibre ^${mapLibreAssets}$
	log_append @loggedMapLibre publicationId {http.regexp.loggedMapLibre.1}` : ''}
	header @loggedFeatures >X-Request-Id {http.request.uuid}
`;
  const publicRoutes = ['conformance', 'static/.+'];
  if (!config.auth) publicRoutes.push('openapi', 'collections');
  if (!config.auth && publicIds.length) publicRoutes.push(collectionRoute(publicIds));

  const featuresHtmlPolicy = config.auth ? `
				header_down Content-Security-Policy "script-src 'none'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'"
				header_down X-Content-Type-Options nosniff` : '';
  const proxyFeatures = `uri strip_prefix /features
			reverse_proxy pygeoapi:80 {
				header_up -Cookie
				header_up -Authorization
				header_down Cache-Control no-store${featuresHtmlPolicy}
			}`;
  const metadataRoutes = config.auth ? `
	@metadata {
		method GET HEAD
		path /features/openapi /features/collections
	}
	handle @metadata {
		route {${protectedIds.length ? '' : '\n\t\t\tvars public_auth_pending true'}
			reverse_proxy access:3000 {
				header_up X-GIS-Request-Id {http.request.uuid}
			}
		}
	}
` : '';
  function publicationRoutes(ids: string[], allowAnonymousFallback: boolean) {
    if (!ids.length) return '';
    const matcher = allowAnonymousFallback ? 'publicPublication' : 'protectedPublication';
    return `
	@${matcher} {
		method GET HEAD
		path_regexp ${matcher} ^/features/${collectionRoute(ids)}$
	}
	handle @${matcher} {
		route {${allowAnonymousFallback ? '\n\t\t\tvars public_auth_pending true' : ''}
			forward_auth access:3000 {
				uri /internal/authorize/{http.regexp.${matcher}.1}
				header_up X-GIS-Request-Id {http.request.uuid}
			}${allowAnonymousFallback ? '\n\t\t\tvars public_auth_pending false' : ''}
			${proxyFeatures}
		}
	}
`;
  }
  const publicAuthFallback = config.auth && (publicIds.length || !protectedIds.length) ? `
		@publicAuthUnavailable vars public_auth_pending true
		handle @publicAuthUnavailable {
			route {
				${proxyFeatures}
			}
		}
` : '';
  const accounts = config.auth ? `
	@accounts path /account /account/* /api/auth/*
	handle @accounts {
		reverse_proxy access:3000 {
			@accessFailure status 500 502 504
			handle_response @accessFailure {
				header Cache-Control no-store
				header Content-Type application/json
				respond \`{"code":"ServiceUnavailable"}\` 503
			}
		}
	}
` : '';
  const managed = config.providers && managedGatewayRoutes(config, collectionRoute, featuresHtmlPolicy);
  const routes = managed ? `${accounts}\n${managed.routes}
	handle {
		header Cache-Control no-store
		respond 404
	}
` : `
${accounts}
${metadataRoutes}
${config.auth ? publicationRoutes(protectedIds, false) + publicationRoutes(publicIds, true) : ''}
	@features {
		method GET HEAD
		path_regexp ^/features(/?|/(${publicRoutes.join('|')}))$
	}
	handle @features {
		route {
			${proxyFeatures}
		}
	}
	handle {
		header Cache-Control no-store
		respond 404
	}
`;
  const errors = `
	handle_errors 5xx {
		header X-Request-Id {http.request.uuid}${managed ? managed.fallback : publicAuthFallback}
		handle {
			header Cache-Control no-store
			header Content-Type application/json
			respond \`{"code":"ServiceUnavailable"}\` 503
		}
	}
`;
  return `{
	admin off${tlsOptions}
	log {
		format filter {
			wrap json
			request delete
			resp_headers delete
		}
	}
}

${site} {${certificate}
${journal}
	route {
		@switching file {
			root /etc/caddy/gis
			try_files closed
		}
		header @switching Cache-Control no-store
		header @switching Content-Type application/json
		respond @switching \`{"code":"ServiceUnavailable"}\` 503
${routes}
	}
${errors}
}

http://:2080 {
	bind 127.0.0.1
	route {
${routes}
	}
${errors}
}
`;
}

function corsRoutes(name: string, path: string, origins: string[]) {
  const allowed = `header_regexp Origin ^(?:${origins.map((value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})$`;
  return `
	@${name}Path ${path}
	header @${name}Path +Vary Origin
	@${name} {
		${path}
		${allowed}
	}
	header @${name} {
		Access-Control-Allow-Origin {http.request.header.Origin}
	}
	@${name}Preflight {
		${path}
		method OPTIONS
		${allowed}
		header_regexp Access-Control-Request-Method ^(GET|HEAD)$
	}
	header @${name}Preflight {
		Access-Control-Allow-Methods "GET, HEAD"
		Access-Control-Allow-Headers Authorization
		Cache-Control no-store
	}
	respond @${name}Preflight 204
`;
}

function mapLibreFileServer(recover = false) {
  // Caddy preserves the proxy failure status in an error route. Serve the whole public file there.
  const recoveryHeaders = ['Range', 'If-Match', 'If-None-Match', 'If-Modified-Since', 'If-Unmodified-Since'];
  const fullResponse = recover ? recoveryHeaders.map((header) => `request_header -${header}\n\t\t\t`).join('') : '';
  return `${fullResponse}header X-Content-Type-Options nosniff
			header Content-Security-Policy "default-src 'none'; frame-ancestors 'none'"
			file_server {
				root /etc/caddy/gis/maplibre
				pass_thru${recover ? '\n\t\t\t\tstatus 200' : ''}
			}
			respond 404`;
}

function managedGatewayRoutes(config: FeaturesConfig,
  collectionRoute: (ids: string[], protocol?: Publication['protocol']) => string, htmlPolicy: string) {
  const routes: string[] = [];
  const fallback: string[] = [];
  const publications = publicationEntries(config);
  const origins = [...new Set([new URL(config.publicUrl).origin, ...config.cors?.allowed_origins ?? []])];
  const metadataFallback = config.auth && publications.every(([, publication]) => publication.access === 'public');
  const byRoot = new Map<string, string[]>();
  for (const id of Object.keys(config.providers ?? {})) {
    const root = providerRoot(config, id);
    byRoot.set(root, [...(byRoot.get(root) ?? []), id]);
  }
  if (!byRoot.size) byRoot.set('/features', []);
  for (const [root, ids] of byRoot) {
    const rootIndex = routes.length;
    const entries = publications.filter(([, publication]) => ids.includes(publication.provider));
    const mvt = root === '/mvt';
    const tiles = ids.some((id) => {
      const instance = config.providers?.[id];
      return instance?.image && instance.api.protocol === 'tiles';
    });
    const rootProvider = (tiles && entries[0]?.[1].provider) || ids[0];
    const metadata = config.auth ? 'access' : 'metadata';
    const managedConformance = entries.some(([, publication]) => vectorFile(config, publication.source));
    if (tiles) {
      const paths = ['/?', '/collections', '/openapi', '/conformance', '/[Tt]ileMatrixSets(/[^/]+)?'];
      if (entries.length) paths.push('/' + collectionRoute(entries.map(([id]) => id), 'tiles'));
      routes.push(corsRoutes(`cors${rootIndex}`, `path_regexp ^${root}(${paths.join('|')})$`, origins));
    }
    if (!mvt) routes.push(`
	@metadata${rootIndex} {
		method GET HEAD
		path ${root}/collections ${root}/openapi${managedConformance ? ` ${root}/conformance` : ''}
	}
	handle @metadata${rootIndex} {
		route {${metadataFallback ? '\n			vars public_metadata true' : ''}
			reverse_proxy ${metadata}:3000 {
				header_up X-GIS-Request-Id {http.request.uuid}
			}
		}
	}
`);
    for (const id of ids) {
      const providerEntries = entries.filter(([, entry]) => entry.provider === id);
      const instance = config.providers?.[id];
      const api = instance?.image ? instance.api : undefined;
      const maps = api?.protocol === 'maps';
      const { host, protocol } = new URL(config.publicUrl);
      const canonical = mvt ? `
				header_up Host ${host}
				header_up X-Forwarded-Host ${host}
				header_up X-Forwarded-Proto ${protocol.slice(0, -1)}
				header_up -Forwarded` : '';
      const mapPath = `${root}/collections/*/map`;
      const mapRequest = maps ? `forward_auth ${mapPath} metadata:3000 {
				uri /internal/validate-map
				header_up -Cookie
				header_up -Authorization
			}
			request_header ${mapPath} Accept image/png
			` : '';
      const tileAccept = tiles ? `
			@tileDefaultFormat {
				path_regexp ^${root}/collections/[^/]+/tiles/${matrixSet}/[0-9]+/[0-9]+/[0-9]+$
				expression \`{http.request.header.Accept} in ["", "*/*"]\`
			}
			request_header @tileDefaultFormat Accept ${vectorTileType}
			@tilesDefaultFormat expression \`{http.request.header.Accept} in ["", "*/*"]\`
			request_header @tilesDefaultFormat Accept application/json
			` : '';
      const base = api?.base_path === '/' ? '' : api?.base_path ?? '';
      const upstream = `${serviceName(config, id)}:${api?.port ?? 80}`;
      const tileJsonChecks = mvt ? providerEntries.filter(([, entry]) => postgisSource(config, entry.source))
        .map(([key, publication], index) => `
			@tileJsonSource${index} path ${root}/${key}
			forward_auth @tileJsonSource${index} ${upstream} {
				uri ${publicationHealth(config, key, publication).source.path}
				header_up -*
				header_up Accept ${vectorTileType}
				transport http {
					response_header_timeout 15s
				}
				@tileJsonFailure status 3xx 4xx 5xx
				handle_response @tileJsonFailure {
					header Cache-Control no-store
					header Content-Type application/json
					respond \`{"code":"ServiceUnavailable"}\` 503
				}
			}
			`).join('') : '';
      const proxy = (postgis = false) => `${mapRequest}${tileAccept}${postgis ? tileJsonChecks : ''}uri strip_prefix ${root}
			${tiles ? 'uri replace /tileMatrixSets /TileMatrixSets' : ''}
			${base || mvt ? `rewrite * ${base}{http.request.uri.path}${mvt ? '?' : ''}` : ''}
			reverse_proxy ${upstream} {
				${postgis || tiles ? `transport http {
					response_header_timeout 15s
				}` : ''}
				header_up -Cookie
				header_up -Authorization${canonical}
				header_down Cache-Control no-store${htmlPolicy}${postgis || mvt || maps ? `
				@sourceFailure status 5xx
				handle_response @sourceFailure {
					header Cache-Control no-store
					header Content-Type application/json
					respond \`{"code":"ServiceUnavailable"}\` 503
				}` : ''}
			}`;
      if (!mvt && id === rootProvider) {
        routes.push(`
	@root${rootIndex} {
		method GET HEAD
		path ${root} ${root}/ ${root}/static/*${managedConformance ? '' : ` ${root}/conformance`}${tiles ?
          ` ${root}/TileMatrixSets ${root}/tileMatrixSets ${root}/TileMatrixSets/*` : ''}
	}
	handle @root${rootIndex} {
		route {${tiles ? `
			@tilesLanding path ${root}
			rewrite @tilesLanding ${root}/` : ''}
			${proxy()}
		}
	}
`);
      }
      if (mvt && providerEntries.length) {
        const paths = [collectionRoute(providerEntries.map(([key]) => key), 'mvt')];
        const styled = providerEntries.filter(([, entry]) => entry.maplibre).map(([key]) => key);
        if (styled.length) paths.push(`(?:${styled.join('|')})/${mapLibreAssetRoute}`);
        routes.push(corsRoutes(`cors${routes.length}`, `path_regexp ^${root}/(?:${paths.join('|')})$`, origins));
      }
      function addPublicationRoute(anonymous: boolean, upstream: string, match: (name: string) => string,
        recovery = upstream) {
        const name = `provider${routes.length}`;
        routes.push(`
	@${name} {
		${match(name)}
	}
	handle @${name} {
		route {${mvt ? '\n			header >Cache-Control no-store' : ''}${config.auth ? `${anonymous ? `\n			vars public_provider ${name}` : ''}
			forward_auth access:3000 {
				uri /internal/authorize/{http.regexp.${name}.1}
				header_up X-GIS-Request-Id {http.request.uuid}
			}${anonymous ? '\n			vars public_provider false' : ''}` : ''}
			${upstream}
		}
	}
`);
        if (config.auth && anonymous) fallback.push(`
		@${name}Unavailable vars public_provider ${name}
		handle @${name}Unavailable {
			route {${mvt ? '\n\t\t\t\theader >Cache-Control no-store' : ''}
				${recovery}
			}
		}`);
      }
      for (const anonymous of [true, false]) {
        for (const postgis of [false, true]) {
          const visible = providerEntries.filter(([, entry]) => (entry.access === 'public') === anonymous &&
            Boolean(postgisSource(config, entry.source)) === postgis).map(([key]) => key);
          if (!visible.length) continue;
          addPublicationRoute(anonymous, proxy(postgis), (name) => `method GET HEAD
		path_regexp ${name} ^${root}/${collectionRoute(visible, api?.protocol ?? 'features')}$`);
          if (postgis && !mvt && !tiles) addPublicationRoute(anonymous, proxy(true), (name) => `method POST
		header_regexp Content-Type (?i)^application/json(?:\\s*;.*)?$
		path_regexp ${name} ^${root}/collections/(${visible.join('|')})/items$`);
        }
        const styled = providerEntries.filter(([, entry]) => entry.maplibre && (entry.access === 'public') === anonymous)
          .map(([key]) => key);
        if (styled.length) addPublicationRoute(anonymous, mapLibreFileServer(), (name) => `method GET HEAD
		path_regexp ${name} ^${root}/(${styled.join('|')})/${mapLibreAssetRoute}$`, mapLibreFileServer(true));
      }
    }
  }
  if (metadataFallback) fallback.push(`
		@publicMetadataUnavailable vars public_metadata true
		handle @publicMetadataUnavailable {
			reverse_proxy metadata:3000
		}`);
  return { routes: routes.join('\n'), fallback: fallback.join('\n') };
}

interface Revision {
  config: FeaturesConfig;
  directory: string;
}

export class FeaturesPreflightError extends Error {}

export async function sourceFingerprint(path: string) {
  const hash = createHash('sha256');
  try {
    for await (const chunk of createReadStream(path)) hash.update(chunk);
    return hash.digest('hex');
  } catch {
    return null;
  }
}

function sourceMountPath(id: string, filename: string) {
  return `/source/${id}/${filename}`;
}

function fileParts(id: string, source: FileSource) {
  if (source.type === 'mbtiles' || source.type === 'pmtiles') {
    return [{ path: source.path, target: tileArchivePath(id, source), optional: false }];
  }
  if (source.type === 'geotiff' || source.type === 'cog') {
    return [{ path: source.path, target: sourceMountPath(id, 'raster.tif'), optional: false }];
  }
  const extension = extname(source.path);
  const base = source.path.slice(0, -extension.length);
  const extensions = source.type === 'shapefile' ? ['.shp', '.dbf', '.shx', '.prj', '.cpg'] : [extension];
  return extensions.map((suffix) => ({
    path: base + suffix, target: sourceMountPath(id, basename(base) + suffix), optional: suffix === '.cpg',
  }));
}

type SourceMount = { type: 'bind'; source: string; target: string; read_only: true; bind: { create_host_path: false } };

export async function fileFingerprints(config: FeaturesConfig) {
  const entries = await Promise.all(usedFileSources(config).map(async ([id, source]) => {
    const parts = await Promise.all(fileParts(id, source).map(async ({ path, optional }) =>
      ({ path, optional, hash: await sourceFingerprint(path) })));
    const hash = parts.every((part) => part.hash || part.optional)
      ? createHash('sha256').update(JSON.stringify(parts)).digest('hex') : null;
    return [id, hash] as const;
  }));
  return Object.fromEntries(entries);
}

export async function savedFileFingerprints(directory: string): Promise<Record<string, string | null>> {
  return readFile(join(directory, 'vector-files.json'), 'utf8').then(JSON.parse).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error;
    return {};
  });
}

export async function savedSourceFingerprint(directory: string) {
  return readFile(join(directory, 'source.sha256'), 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error;
    return null;
  });
}

export async function archiveLegacyOpenApi({ config, directory }: Revision) {
  const output = await compose(config, directory, 'exec', '-T', 'pygeoapi', 'cat', '/pygeoapi/local.openapi.yml');
  const body = JSON.stringify(parse(output));
  checkOpenApi(body, config.publicUrl, publicationEntries(config));
  await writeFile(join(directory, 'openapi.json'), body);
}

export async function prepareFeaturesStack({ config, directory: revisionDirectory }: Revision,
  options: { previous?: Revision; sourceHash?: string | null; fileHashes?: Record<string, string | null>;
    useArchivedOpenApi?: boolean } = {}) {
  const { previous, useArchivedOpenApi } = options;
  await mkdir(revisionDirectory, { recursive: true, mode: 0o700 });
  await rm(join(revisionDirectory, 'provider-directory'), { force: true });
  const sameSource = previous?.config.sourcePath === config.sourcePath;
  const hasPublications = config.publicationId !== null;
  const sourceHash = hasGeoJson(config) ? await sourceFingerprint(config.sourcePath) : null;
  const previousHash = previous && await savedSourceFingerprint(previous.directory);
  if ((options.sourceHash && sourceHash && sourceHash !== options.sourceHash) ||
      (options.sourceHash === null && sameSource && sourceHash && previousHash && sourceHash !== previousHash)) {
    throw new Error('The GeoJSON source changed after planning.');
  }
  const fileHashes = await fileFingerprints(config);
  const previousFileHashes = previous ? await savedFileFingerprints(previous.directory) : {};
  const offlineFiles = new Set<string>();
  for (const [id, hash] of Object.entries(fileHashes)) {
    const expected = options.fileHashes?.[id];
    const label = tileArchive(config, id) ? 'Tile archive' : rasterFile(config, id) ? 'Raster file' : 'Vector file';
    if (!hash) {
      const unchanged = previous && expected === null && Object.hasOwn(previousFileHashes, id) &&
        publicationEntries(config).filter(([, publication]) => publication.source === id).every(([, { provider }]) =>
          !providerConfigurationChanged(config, previous.config, provider) &&
          usedFileSources(config, provider).every(([key]) => Object.hasOwn(previousFileHashes, key) &&
            (fileHashes[key] === previousFileHashes[key] || options.fileHashes?.[key] === null && !fileHashes[key])));
      if (!unchanged) throw new FeaturesPreflightError(`${label} source '${id}'${vectorFile(config, id) ? ' or its sidecar' : ''} is unavailable.`);
      offlineFiles.add(id);
    } else if (options.fileHashes && hash !== (expected ?? previousFileHashes[id])) {
      throw new FeaturesPreflightError(`${label} source '${id}' changed after planning. Create a new plan.`);
    }
  }
  for (const id of offlineFiles) fileHashes[id] = previousFileHashes[id]!;
  if (Object.keys(fileHashes).length) {
    await writeFile(join(revisionDirectory, 'vector-files.json'), JSON.stringify(fileHashes));
  }
  if (config.tls) {
    const cert = new X509Certificate(await readFile(config.tls.cert_file));
    const hostname = new URL(config.publicUrl).hostname;
    const matches = isIP(hostname) ? cert.checkIP(hostname) : cert.checkHost(hostname);
    const now = Date.now();
    if (!matches || now < Date.parse(cert.validFrom) || now > Date.parse(cert.validTo)) {
      throw new Error('Invalid TLS certificate for the public hostname.');
    }
  }
  if (config.auth) {
    const { auth } = config;
    const secret = (await readFile(auth.secret_file, 'utf8')).trim();
    if (Buffer.byteLength(secret) < 32) throw new Error('The auth secret file must contain at least 32 bytes.');
    if (!(await readFile(auth.postgres_password_file, 'utf8')).trim()) {
      throw new Error('The PostgreSQL password file is empty.');
    }
    const smtp = auth.mode === 'development'
      ? { host: 'mailpit', port: 1025, from: 'GIS Platform <accounts@gis-platform.test>' }
      : { host: auth.smtp.host, port: auth.smtp.port, from: auth.smtp.from,
        secure: auth.smtp.secure, username: auth.smtp.username };
    await writeFile(join(revisionDirectory, 'access.json'), JSON.stringify({
      origin: new URL(config.publicUrl).origin, production: auth.mode === 'production', smtp,
      publications: Object.fromEntries(publicationEntries(config).map(([id, { access }]) => [id, access])),
      publicationTitles: Object.fromEntries(publicationEntries(config).map(([id, { title }]) => [id, title])),
      administratorEmails: auth.administrator_emails, managedFeatures: config.providers !== undefined,
      operators: auth.cli?.operators, version: basename(revisionDirectory),
      ...(auth.cli && { publicationHealth: Object.fromEntries(publicationEntries(config)
        .map(([id, publication]) => [id, publicationHealth(config, id, publication)])) }),
    }));
    if (auth.mode === 'production' && auth.smtp.password_file) {
      if (!(await readFile(auth.smtp.password_file, 'utf8')).trim()) throw new Error('The SMTP password file is empty.');
      await writeFile(join(revisionDirectory, 'compose.smtp.json'), JSON.stringify({
        services: { access: { secrets: ['smtp_password'] } },
        secrets: { smtp_password: { file: auth.smtp.password_file } },
      }));
    }
    if (auth.cli) {
      const [ca, cert, key] = await Promise.all([auth.cli.ca_file, auth.cli.cert_file, auth.cli.key_file]
        .map((file) => readFile(file)));
      createSecureContext({ ca, cert, key });
      const secretFiles = { cli_ca: auth.cli.ca_file, cli_cert: auth.cli.cert_file, cli_key: auth.cli.key_file };
      await writeFile(join(revisionDirectory, 'compose.admin.json'), JSON.stringify({
        services: { access: {
          ports: [{ target: 3001, published: String(auth.cli.port), host_ip: '127.0.0.1' }],
          secrets: Object.keys(secretFiles),
          volumes: [{ type: 'bind', source: join(revisionDirectory, '..', '..', 'status').replaceAll('$', () => '$$'),
            target: '/etc/gis-status', read_only: true, bind: { create_host_path: false } }],
        } },
        secrets: Object.fromEntries(Object.entries(secretFiles).map(([name, file]) => [name, { file }])),
      }));
    }
  }
  const providerConfig = JSON.stringify(pygeoapiConfig(config), null, 2);
  await writeFile(join(revisionDirectory, 'pygeoapi.yml'), providerConfig);
  await writeFile(join(revisionDirectory, 'Caddyfile'), caddyConfig(config));
  if (config.providers) {
    await reuseManagedArtifacts(config, revisionDirectory, previous,
      sameSource && (!sourceHash || sourceHash === previousHash) && (!options.sourceHash || options.sourceHash === previousHash),
      fileHashes, previousFileHashes);
    const archived = offlineFiles.size && previous
      ? JSON.parse(await readFile(join(previous.directory, 'compose.providers.json'), 'utf8')) as {
        services: Record<string, { volumes?: SourceMount[] }>;
      }
      : undefined;
    await writeProviderCompose(config, revisionDirectory, offlineFiles, archived?.services);
  }
  await compose(config, revisionDirectory, 'config', '--quiet');
  await compose(config, revisionDirectory, 'run', '--rm', '--no-deps', '-T', '--entrypoint', 'caddy', 'caddy',
    'validate', '--config', '/etc/caddy/gis/Caddyfile', '--adapter', 'caddyfile');

  if (useArchivedOpenApi) {
    const archived = await readFile(join(revisionDirectory, 'openapi.json'), 'utf8').catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
    });
    if (archived) {
      checkOpenApi(archived, config.publicUrl, publicationEntries(config));
      return;
    }
  }
  if (config.providers) {
    await prepareManagedFeatures(config, revisionDirectory, sourceHash,
      sourceHash ?? (sameSource ? previousHash : null));
    return;
  }
  if (previous && previousHash && sameSource && (!sourceHash || sourceHash === previousHash) &&
      (!options.sourceHash || options.sourceHash === previousHash) &&
      !providerConfigurationChanged(config, previous.config)) {
    await copyFile(join(previous.directory, 'openapi.json'), join(revisionDirectory, 'openapi.json'));
    const provider = await nativeProviderDirectory(previous.directory);
    await writeFile(join(revisionDirectory, 'provider-directory'), basename(provider));
    await writeFile(join(revisionDirectory, 'source.sha256'), previousHash);
    return;
  }
  if (hasPublications && !sourceHash) throw new Error('The GeoJSON source is unavailable.');
  const output = await compose(config, revisionDirectory, 'run', '--rm', '--no-deps', '-T', '--entrypoint', '/bin/sh', 'pygeoapi',
    '-ec', [
      ...(hasPublications ? [
        checkGeoJson,
      ] : []),
      generateOpenApi,
      'cat /tmp/openapi.json',
    ].join('\n'));
  checkOpenApi(output, config.publicUrl, publicationEntries(config));
  await writeFile(join(revisionDirectory, 'openapi.json'), output);
  if (sourceHash) await writeFile(join(revisionDirectory, 'source.sha256'), sourceHash);
}

async function writeProviderCompose(config: FeaturesConfig, directory: string,
  offlineFiles: Set<string>, priorServices?: Record<string, { volumes?: SourceMount[] }>) {
  const services: Record<string, unknown> = {};
  const volumes: Record<string, object> = {};
  const secrets: Record<string, { file: string }> = {};
  if (!builtInProviderId(config)) services.pygeoapi = { profiles: ['unused-built-in'] };
  if (needsMetadataService(config)) services.metadata = {
    build: { context: '.', dockerfile: 'Dockerfile.access' },
    command: ['node', 'dist/public-metadata.js'],
    restart: 'unless-stopped',
    volumes: [{ type: 'bind', source: '${GIS_REVISION_DIR}', target: '/etc/gis', read_only: true }],
  };
  const escapeCompose = (value: string) => value.replaceAll('$', () => '$$');
  for (const [id, provider] of Object.entries(config.providers ?? {})) {
    const service = serviceName(config, id);
    const secret = `postgis-${id}`;
    const passwordFile = provider.postgis?.password_file;
    const connection = passwordFile && publicationsForProvider(config, id).some(([, publication]) =>
      postgisSource(config, publication.source))
      ? [{ source: secret, target: 'postgis_password' }] : undefined;
    const native = service === 'pygeoapi' ? directory : join(directory, service);
    await mkdir(native, { recursive: true });
    const files = usedFileSources(config, id);
    const vectorFiles = files.some(([key]) => vectorFile(config, key));
    const fileMounts = (await Promise.all(files.map(async ([key, file]) => {
      if (offlineFiles.has(key)) {
        return priorServices?.[service]?.volumes?.filter(({ target }) => target.startsWith(`/source/${key}/`)) ?? [];
      }
      const parts = fileParts(key, file);
      return (await Promise.all(parts.map(async ({ path, target, optional }): Promise<SourceMount[]> => {
        if (optional && !await sourceFingerprint(path)) return [];
        return [{ type: 'bind', source: escapeCompose(path), target: escapeCompose(target), read_only: true,
          bind: { create_host_path: false } }];
      }))).flat();
    }))).flat();
    if (provider.type === 'martin') {
      if (!managedProviderRuns(config, id)) continue;
      await writeFile(join(native, 'martin.yaml'), stringify(martinConfig(config, id)));
      await writeFile(join(native, 'run.sh'), runMartin);
      if (connection) secrets[secret] = { file: escapeCompose(passwordFile!) };
      const serviceSettings = martinService(provider, escapeCompose(await nativeProviderDirectory(directory, service)), connection);
      services[service] = { ...serviceSettings, volumes: [...serviceSettings.volumes, ...fileMounts] };
      continue;
    }
    const tiles = provider.image && provider.api.protocol === 'tiles';
    const pluginEnvironment = connection || vectorFiles || tiles ? {
      PYTHONPATH: '/etc/pygeoapi/gis' + (provider.image && provider.environment?.PYTHONPATH
        ? `:${escapeCompose(provider.environment.PYTHONPATH)}` : ''),
    } : undefined;
    if (vectorFiles) {
      await copyFile(fileURLToPath(new URL('../src/gis_vector_files.py', import.meta.url)), join(native, 'gis_vector_files.py'));
    }
    if (connection) {
      secrets[secret] = { file: escapeCompose(passwordFile!) };
      await copyFile(fileURLToPath(new URL('../src/gis_postgis.py', import.meta.url)), join(native, 'gis_postgis.py'));
    }
    if (tiles) {
      await copyFile(fileURLToPath(new URL('../src/gis_tiles.py', import.meta.url)), join(native, 'gis_tiles.py'));
    }
    if (!provider.image) {
      if (connection || files.length) services[service] = {
        environment: pluginEnvironment, volumes: fileMounts, secrets: connection,
        ...(files.some(([, file]) => file.type === 'geoparquet') && {
          image: parquetImage,
          build: { context: '.', dockerfile: 'Dockerfile.pygeoapi' },
        }),
      };
      continue;
    }
    const { port, scheme, base_path: base, readiness } = provider.api;
    await writeFile(join(native, 'pygeoapi.yml'), JSON.stringify(pygeoapiConfig(config, id)));
    const namedVolumes = Object.entries(provider.volumes ?? {}).map(([name, target]) => {
      const volume = `${service}_${name}`;
      volumes[volume] = {};
      return { type: 'volume', source: volume, target };
    });
    services[service] = {
      image: pinnedImage(provider),
      restart: 'unless-stopped',
      environment: {
        ...Object.fromEntries(Object.entries(provider.environment ?? {}).map(([name, value]) => [name, escapeCompose(value)])),
        PYGEOAPI_CONFIG: '/etc/pygeoapi/gis/pygeoapi.yml',
        PYGEOAPI_OPENAPI: '/etc/pygeoapi/gis/openapi.json',
        ...pluginEnvironment,
        ...(base !== '/' && { SCRIPT_NAME: base }),
      },
      entrypoint: ['/venv/bin/gunicorn'],
      command: ['--workers', '1', '--worker-class', 'gevent', '--timeout', '6000',
        '--bind', `0.0.0.0:${port}`, 'pygeoapi.flask_app:APP'],
      volumes: [
        { type: 'bind', source: escapeCompose(await nativeProviderDirectory(directory, service)), target: '/etc/pygeoapi/gis', read_only: true,
          bind: { create_host_path: false } },
        ...(hasGeoJson(config, id)
          ? [{ type: 'bind', source: '${GIS_SOURCE_FILE}', target: '/source/data.geojson', read_only: true,
            bind: { create_host_path: false } }] : []),
        ...namedVolumes,
        ...fileMounts,
      ],
      ...(connection && { secrets: connection }),
      healthcheck: {
        test: ['CMD', '/venv/bin/python', '-c',
          `from urllib.request import urlopen; urlopen('${scheme}://127.0.0.1:${port}${base === '/' ? '' : base}${connection ? '/openapi?f=json' : readiness}', timeout=2).read()`],
        interval: '2s', timeout: '3s', retries: 25,
      },
    };
  }
  await writeFile(join(directory, 'compose.providers.json'), JSON.stringify({ services, volumes, secrets }));
}

const checkGeoJson = `/venv/bin/python -c "from pygeoapi.provider.geojson import GeoJSONProvider; GeoJSONProvider({'name': 'GeoJSON', 'type': 'feature', 'data': '/source/data.geojson', 'id_field': 'id'}).query(limit=1)" >/dev/null`;
const checkSourcePlugins = `/venv/bin/python - <<'PY'
import json
import os
import sys
from pygeoapi.crs import DEFAULT_CRS, get_crs
from pygeoapi.plugin import load_plugin
from pygeoapi.provider.base import ProviderGenericError
from pyproj import Transformer
from pyproj.exceptions import ProjError

with open(os.environ['PYGEOAPI_CONFIG']) as config:
    resources = json.load(config)['resources']
for identifier, resource in resources.items():
    definition = resource['providers'][0]
    for index, uri in enumerate(definition.get('crs', [])):
        try:
            source = get_crs(DEFAULT_CRS)
            target = get_crs(uri)
            if len(target.axis_info) != 2 or not (target.is_geographic or target.is_projected):
                raise ValueError("Expected a two-dimensional geographic or projected CRS.")
            west, south, east, north = resource['extents']['spatial']['bbox']
            center = ((west + east) / 2, (south + north) / 2)
            projected = Transformer.from_crs(source, target).transform(*center, errcheck=True)
            Transformer.from_crs(target, source).transform(*projected, errcheck=True)
        except (ValueError, ProjError):
            sys.exit(f"GIS_UNSUPPORTED_CRS {identifier} {index}")
    if definition['name'] == '${vectorFilePlugin}':
        load_plugin('provider', definition).validate_source()
    if definition['name'] == 'MapScript':
        from osgeo import gdal, osr

        try:
            gdal.UseExceptions()
            raster = gdal.OpenEx(definition['data'], gdal.OF_RASTER, allowed_drivers=['GTiff'])
            if definition['options']['cog'] and raster.GetMetadataItem('LAYOUT', 'IMAGE_STRUCTURE') != 'COG':
                raise ValueError('Expected a cloud optimized GeoTIFF.')
            source_crs = raster.GetSpatialRef()
            expected_crs = osr.SpatialReference()
            expected_crs.ImportFromEPSG(definition['options']['projection'])
            expected_crs.SetAxisMappingStrategy(osr.OAMS_TRADITIONAL_GIS_ORDER)
            if (source_crs is None or not source_crs.IsSame(expected_crs)
                    or raster.GetGeoTransform(can_return_null=True) is None):
                raise ValueError('Expected a georeferenced raster with the configured EPSG code.')
            raster.ReadRaster(raster.RasterXSize // 2, raster.RasterYSize // 2, 1, 1)
            image = load_plugin('provider', definition).query(
                bbox=resource['extents']['spatial']['bbox'], width=32, height=32, crs=DEFAULT_CRS)
            if not image.startswith(bytes.fromhex('89504e470d0a1a0a')):
                raise ValueError('Expected a PNG from the provider.')
        except (RuntimeError, ValueError, TypeError, ProviderGenericError):
            sys.exit(f"GIS_INVALID_RASTER {identifier}")
    if definition['name'] == '${postgisPlugin}':
        provider = load_plugin('provider', definition)
        if provider.time_field:
            time_field = provider.fields.get(provider.time_field, {})
            if time_field.get('format') != 'date-time':
                raise ValueError('PostGIS time_field must reference a timestamp column.')
        provider.query(limit=1, bbox=resource['extents']['spatial']['bbox'])
PY`;
const generateOpenApi = '/venv/bin/pygeoapi openapi generate "$PYGEOAPI_CONFIG" -f json -of /tmp/openapi.json >/dev/null';

async function reuseManagedArtifacts(config: FeaturesConfig, directory: string, previous: Revision | undefined,
  sameSourceContent: boolean, fileHashes: Record<string, string | null>, previousFileHashes: Record<string, string | null>) {
  for (const [id, provider] of Object.entries(config.providers ?? {})) {
    const service = serviceName(config, id);
    const draft = service === 'pygeoapi' ? directory : join(directory, service);
    await mkdir(draft, { recursive: true });
    await rm(join(draft, 'provider-directory'), { force: true });
    if (!previous || (hasGeoJson(config, id) && !sameSourceContent) ||
        usedFileSources(config, id).some(([key]) => fileHashes[key] !== previousFileHashes[key]) ||
        providerConfigurationChanged(config, previous.config, id)) continue;
    const prior = previous.config.providers?.[id];
    const exists = provider.image ? prior?.image && JSON.stringify(prior) === JSON.stringify(provider)
      : id === builtInProviderId(previous.config);
    if (!exists) continue;
    const native = await nativeProviderDirectory(previous.directory, service);
    const version = basename(service === 'pygeoapi' ? native : join(native, '..'));
    await writeFile(join(draft, 'provider-directory'), version);
  }
}

async function prepareManagedFeatures(config: FeaturesConfig, directory: string, sourceHash: string | null,
  savedHash?: string | null) {
  const documents: Record<string, { url: string; api: FeaturesOpenApi }> = {};
  const providers = Object.keys(config.providers ?? {});
  const entries = publicationEntries(config);
  for (const id of providers) {
    const instance = config.providers?.[id];
    const root = providerRoot(config, id);
    const url = new URL(root, config.publicUrl).href;
    const service = serviceName(config, id);
    const publications = entries.filter(([, pub]) => pub.provider === id);
    const native = service === 'pygeoapi' ? directory : join(directory, service);
    const mounted = await nativeProviderDirectory(directory, service);
    if (instance?.type === 'martin') {
      const rendered = publicationsForProvider(config, id);
      if (rendered.length && mounted === native) {
        try {
          const output = await compose(config, directory, 'run', '--rm', '--no-deps', '-T', service,
            '--check', ...rendered.map(([key]) => key));
          const [catalog, ...documents] = output.trim().split('\n');
          const { tiles } = JSON.parse(catalog ?? '') as { tiles: Record<string, { content_type: string }> };
          for (const [index, [key, publication]] of rendered.entries()) {
            const source = postgisSource(config, publication.source);
            if (!source && !tiles[key]?.content_type?.startsWith('image/')) {
              throw new Error(`Publication '${key}' does not contain raster tiles.`);
            }
            checkTileJson(documents[index] ?? '', `http://127.0.0.1:${instance.api.port}${root}/${key}`, key,
              source?.id_field);
          }
        } catch {
          if (!instance.postgis) {
            throw new FeaturesPreflightError(`Martin provider '${id}' failed to open its tile archives. Check the archive format, raster tiles and TileJSON.`);
          }
          throw new FeaturesPreflightError(`Martin provider '${id}' failed to open its PostGIS sources. Check connectivity, access and source definitions.`);
        }
      }
      continue;
    }
    let api: FeaturesOpenApi;
    if (mounted !== native) {
      api = checkOpenApi(await readFile(join(mounted, 'openapi.json'), 'utf8'), url, publications);
    } else {
      const geojson = hasGeoJson(config, id);
      if (geojson && !sourceHash) throw new Error('The GeoJSON source is unavailable.');
      const checkPlugins = publications.some(([, publication]) => publication.protocol !== 'tiles' &&
        (publication.crs || postgisSource(config, publication.source) || vectorFile(config, publication.source) || publication.protocol === 'maps'));
      if (!config.providers?.[id]?.image && usedFileSources(config, id).some(([, file]) => file.type === 'geoparquet')) {
        await compose(config, directory, 'build', service);
      }
      const output = await compose(config, directory, 'run', '--rm', '--no-deps', '-T', '--entrypoint', '/bin/sh', service,
        '-ec', [...(geojson ? [checkGeoJson] : []), ...(checkPlugins ? [checkSourcePlugins] : []),
          generateOpenApi, 'cat /tmp/openapi.json'].join('\n')).catch((error: unknown) => {
        if (error instanceof Error && 'stderr' in error && typeof error.stderr === 'string') {
          const failure = /^GIS_UNSUPPORTED_CRS ([a-z][a-z0-9-]*) (\d+)\r?$/m.exec(error.stderr);
          const publication = failure && publications.find(([key]) => key === failure[1]);
          const crs = publication && publication[1].crs?.[Number(failure[2])];
          if (crs) throw new FeaturesPreflightError(`Publication '${publication[0]}': CRS ${crs} is unsupported by provider '${id}'.`);
          const invalidRaster = /^GIS_INVALID_RASTER ([a-z][a-z0-9-]*)\r?$/m.exec(error.stderr);
          if (invalidRaster) {
            throw new FeaturesPreflightError(
              `Publication '${invalidRaster[1]}': unable to render the raster. Check its format, georeferencing and EPSG code.`);
          }
        }
        throw error;
      });
      api = checkOpenApi(output, url, publications);
    }
    await writeFile(join(native, 'openapi.json'), JSON.stringify(api));
    if (instance?.image && instance.api.protocol === 'tiles') {
      api.paths!['/TileMatrixSets'] = { get: {
        summary: 'List tile matrix set definitions.',
        responses: { '200': { description: 'Tile matrix sets' } },
      } };
      api.paths!['/TileMatrixSets/{tileMatrixSetId}'] = { get: {
        summary: 'Get a tile matrix set definition.',
        parameters: [{ name: 'tileMatrixSetId', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '200': { description: 'Tile matrix set' }, '400': { description: 'Unknown tile matrix set.' } },
      } };
    }
    for (const [publicationId, publication] of publications) {
      const collection = `/collections/${publicationId}`;
      if (publication.protocol === 'tiles') {
        const list = `${collection}/tiles`;
        const tile = `${list}/{tileMatrixSetId}/{tileMatrix}/{tileRow}/{tileCol}`;
        const matrixParameter = { name: 'tileMatrixSetId', in: 'path', required: true,
          schema: { type: 'string', enum: [matrixSet] } };
        api.paths![`${list}/{tileMatrixSetId}`] = { get: {
          summary: 'Get the WebMercatorQuad tileset metadata.',
          operationId: `${publicationId}.collection.vector.getTileSet`,
          tags: [publicationId],
          parameters: [matrixParameter, { name: 'f', in: 'query', schema: {
            type: 'string', enum: ['json', 'html', 'jsonld', 'tilejson'], default: 'json',
          } }],
          responses: { '200': { description: 'Tileset metadata', content: {
            'application/json': { schema: { oneOf: [
              { $ref: 'https://schemas.opengis.net/tms/2.0/json/tileSet.json' },
              { type: 'object', required: ['tilejson', 'tiles', 'vector_layers'], properties: {
                tilejson: { type: 'string' }, tiles: { type: 'array', items: { type: 'string' } },
                vector_layers: { type: 'array', items: { type: 'object' } },
              } },
            ] } },
          } }, '404': { description: 'Tile matrix set not found.' } },
        } };
        const operation = api.paths![tile]?.get;
        if (!operation) throw new Error(`Publication '${publicationId}' is missing its tile operation.`);
        operation.parameters = [matrixParameter,
          { name: 'tileMatrix', in: 'path', required: true, schema: { type: 'string' },
            description: 'Identifier of a tile matrix in WebMercatorQuad.' },
          ...['tileRow', 'tileCol'].map((name) => ({
            name, in: 'path', required: true, schema: { type: 'integer', minimum: 0 },
            description: `Zero-based ${name === 'tileRow' ? 'row' : 'column'} of the tile in the selected matrix.`,
          })),
          ...(operation.parameters ?? []).filter((parameter) => parameter.in === 'query')];
        operation.responses['200'] = { description: 'Vector tile', content: {
          [vectorTileType]: { schema: { type: 'string', format: 'binary' } },
        } };
        operation.responses['204'] = { description: 'The tile has no data.' };
        operation.responses['503'] = { description: 'The publication source is temporarily unavailable.' };
      }
      const map = api.paths?.[`${collection}/map`]?.get;
      if (publication.protocol === 'maps' && map) {
        map.parameters = [
          { name: 'bbox', in: 'query', description: mapBboxDescription, style: 'form', explode: false,
            schema: { type: 'array', items: { type: 'number' }, minItems: 4, maxItems: 4 } },
          ...(['width', 'height'] as const).map((name) => ({
            name, in: 'query', description: `Response image ${name} in pixels.`,
            schema: { type: 'integer', minimum: mapSize.minimum, maximum: mapSize.maximum, default: mapSize[name] },
          })),
          { name: 'f', in: 'query', schema: { type: 'string', enum: ['png'], default: 'png' } },
        ];
        map.responses['200'] = { description: 'PNG map image', content: { 'image/png': {
          schema: { type: 'string', format: 'binary' },
        } } };
        map.responses['400'] = { description: 'Invalid map parameter', content: { 'application/json': {
          schema: { type: 'object', required: ['code', 'description'],
            properties: { code: { type: 'string', enum: ['InvalidParameterValue'] }, description: { type: 'string' } } },
        } } };
        delete map.responses['500'];
        map.responses['503'] = { description: 'The publication source is temporarily unavailable.' };
      }
      const items = api.paths?.[`${collection}/items`];
      if (!items) continue;
      if (!postgisSource(config, publication.source)) {
        delete items.post;
        if (vectorFile(config, publication.source) && items.get) {
          items.get.parameters = items.get.parameters?.flatMap((parameter) => {
            const name = parameter.name ?? parameter.$ref?.split('/').at(-1);
            if (name === 'sortby') return [];
            if (name !== 'bbox') return [parameter];
            const bbox = parameter.$ref ? api.components?.parameters?.bbox : parameter;
            return bbox ? [{ ...bbox, description: 'Four coordinates in the axis order of bbox-crs.',
              schema: { ...bbox.schema, minItems: 4, maxItems: 4 } }] : [parameter];
          });
        }
        continue;
      }
      items.get?.parameters?.push(
        { name: 'filter', in: 'query', description: 'A CQL2 Text expression.', schema: { type: 'string' } },
        { name: 'filter-lang', in: 'query', schema: { type: 'string', enum: ['cql2-text'] } },
      );
      if (items.post) {
        items.post.description = 'Send a CQL2 JSON expression in the request body. Use POST with the same body at each page URL.';
        items.post.parameters = [
          { name: 'filter-lang', in: 'query', schema: { type: 'string', enum: ['cql2-json'] } },
        ];
      }
      for (const operation of [items.get, items.post, api.paths?.[`${collection}/items/{featureId}`]?.get]) {
        if (operation) operation.responses['503'] = {
          description: 'The publication source is temporarily unavailable.',
          content: { 'application/json': { schema: { type: 'object', required: ['code'],
            properties: { code: { type: 'string', enum: ['ServiceUnavailable'] } } } } },
        };
      }
    }
    const shared = documents[root];
    if (shared) {
      Object.assign(shared.api.paths!, Object.fromEntries(Object.entries(api.paths ?? {}).filter(([key]) =>
        key.startsWith('/collections/'))));
      shared.api.tags = [...(shared.api.tags ?? []), ...(api.tags ?? []).filter(({ name }) => name !== 'server')];
    } else {
      documents[root] = { url, api };
    }
  }
  if (!providers.length) {
    documents['/features'] = { url: config.publicUrl, api: {
      openapi: '3.0.2', servers: [{ url: config.publicUrl }], info: { title: 'GIS Platform Features', version: '1' },
      components: {}, paths: {},
    } };
  }
  const roots = Object.fromEntries(Object.entries(documents).map(([root, { url, api }]) => [
    root, { url, api, conformsTo: fileConformance(config, root),
      sourceProbes: Object.fromEntries(entries.filter(([, publication]) =>
        postgisSource(config, publication.source) && providerRoot(config, publication.provider) === root)
        .map(([id, publication]) => [id, publicationHealth(config, id, publication).source])),
      collections: entries.filter(([, publication]) => providerRoot(config, publication.provider) === root)
      .map(([id, publication]) => ({
        id, title: publication.title, description: publicationDescription(config, publication),
        ...(publication.protocol === 'features' && { crs: publication.crs ?? [crs84], storageCrs: crs84 }), extent: {
          spatial: { bbox: [publication.extent], crs: crs84 },
          ...(publication.time_field && { temporal: { interval: [[null, null]] } }),
        },
        links: ['json', 'html', 'jsonld'].map((format) => ({
          rel: 'self', href: `${url}/collections/${id}?f=${format}`,
          type: ({ json: 'application/json', html: 'text/html', jsonld: 'application/ld+json' })[format],
        })).concat(publication.protocol === 'maps'
          ? [{ rel: mapRelation, href: `${url}/collections/${id}/map?f=png`, type: 'image/png' }]
          : publication.protocol === 'tiles'
          ? [{ rel: tilesRelation, href: `${url}/collections/${id}/tiles?f=json`, type: 'application/json' }]
          : [{ rel: 'items', href: `${url}/collections/${id}/items?f=json`, type: 'application/geo+json' }]),
      })) },
  ]));
  await writeFile(join(directory, 'features.json'), JSON.stringify(roots));
  if (savedHash) await writeFile(join(directory, 'source.sha256'), savedHash);
}

function fileConformance(config: FeaturesConfig, root: string) {
  const publications = publicationEntries(config).filter(([, publication]) => providerRoot(config, publication.provider) === root);
  if (!publications.some(([, publication]) => vectorFile(config, publication.source))) return undefined;
  const base = 'http://www.opengis.net/spec';
  const features = ['core', 'oas30', 'html', 'geojson'].map((name) => `${base}/ogcapi-features-1/1.0/conf/${name}`);
  features.push(`${base}/ogcapi-features-2/1.0/conf/crs`,
    `${base}/ogcapi-features-3/1.0/conf/queryables`, `${base}/ogcapi-features-3/1.0/conf/queryables-query-parameters`);
  if (publications.some(([, publication]) => postgisSource(config, publication.source))) {
    features.push(`${base}/cql2/1.0/conf/basic-cql2`, `${base}/cql2/1.0/conf/cql2-text`, `${base}/cql2/1.0/conf/cql2-json`);
  }
  return features;
}

async function nativeProviderDirectory(directory: string, service = 'pygeoapi') {
  const native = service === 'pygeoapi' ? directory : join(directory, service);
  const revision = await readFile(join(native, 'provider-directory'), 'utf8').catch(() => undefined);
  if (!revision || !/^plan-[a-f0-9]{64}$/.test(revision)) return native;
  return service === 'pygeoapi' ? join(directory, '..', revision) : join(directory, '..', revision, service);
}

export async function compose(config: FeaturesConfig, revisionDirectory: string, ...args: string[]) {
  const files = [composeFile('compose.yaml')];
  const builtIn = builtInProviderId(config);
  if (config.publicationId === null || (config.providers && (!builtIn || !hasGeoJson(config, builtIn)))) {
    files.push(composeFile('compose.empty.yaml'));
  }
  if (config.tls) files.push(composeFile('compose.tls.yaml'));
  if (config.auth) {
    files.push(composeFile('compose.auth.yaml'));
    if (config.auth.mode === 'development') files.push(composeFile('compose.mailpit.yaml'));
    else if (config.auth.smtp.password_file) files.push(join(revisionDirectory, 'compose.smtp.json'));
    if (config.auth.cli) files.push(join(revisionDirectory, 'compose.admin.json'));
  }
  if (config.providers) files.push(join(revisionDirectory, 'compose.providers.json'));
  const { stdout } = await run('docker', ['compose', ...(project ? ['-p', project] : []),
    ...files.flatMap((file) => ['-f', file]), ...args], {
    env: {
      ...process.env,
      GIS_PUBLIC_PORT: String(config.port),
      GIS_CADDY_PORT: config.tls ? '443' : '80',
      GIS_TLS_CERT_FILE: config.tls?.cert_file,
      GIS_TLS_KEY_FILE: config.tls?.key_file,
      GIS_REVISION_DIR: revisionDirectory,
      GIS_PROVIDER_REVISION_DIR: await nativeProviderDirectory(revisionDirectory),
      GIS_SOURCE_FILE: config.sourcePath,
      GIS_AUTH_SECRET_FILE: config.auth?.secret_file,
      GIS_POSTGRES_PASSWORD_FILE: config.auth?.postgres_password_file,
      GIS_MAILPIT_PORT: config.auth?.mode === 'development' ? String(config.auth.mailpit_port ?? 8025) : undefined,
    },
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
  });
  return stdout;
}

function probeCollection(origin: URL, path: string, certificate: Buffer | undefined) {
  return new Promise<{ status?: number; cacheControl?: string; body: string }>((resolve, reject) => {
    const url = new URL(path, origin);
    url.hostname = '127.0.0.1';
    const get = certificate ? getHttps : getHttp;
    const request = get(url, {
      agent: false,
      headers: { Host: origin.host },
      signal: AbortSignal.timeout(2000),
      ...(certificate && {
        ca: certificate,
        allowPartialTrustChain: true,
        ...(isIP(origin.hostname) === 0 && { servername: origin.hostname }),
        checkServerIdentity: (_hostname, peer) => checkServerIdentity(origin.hostname, peer),
      }),
    }, (response) => {
      text(response).then((body) => resolve({ status: response.statusCode,
        cacheControl: response.headers['cache-control'], body }), reject);
    });
    request.on('error', reject);
  });
}

export async function diagnoseStack({ config, directory }: Revision, publicationId?: string) {
  const entries = Object.fromEntries(publicationEntries(config)
    .map(([id, publication]) => [id, publicationHealth(config, id, publication)]));
  const gateway = async () => {
    try {
      const certificate = config.tls ? await readFile(config.tls.cert_file) : undefined;
      const { status, cacheControl } = await probeCollection(new URL(config.publicUrl), '/', certificate);
      if (cacheControl === 'no-store') {
        if (status === 404) return 'ready';
        if (status === 503) return 'closed';
      }
    } catch {
      // Diagnostic results do not include connection details.
    }
    return 'unavailable';
  };
  const [gatewayState, publications] = await Promise.all([
    gateway(),
    publicationChecks(entries, (endpoint) => {
      const url = healthUrl(endpoint, '127.0.0.1');
      const probe = endpoint.martin
        ? ['wget', '-q', '-T', '3', '-O', '/dev/null', url]
        : ['/venv/bin/python', '-c',
          'import sys; from urllib.request import urlopen; urlopen(sys.argv[1], timeout=3).close()', url];
      return compose(config, directory, 'exec', '-T', endpoint.service, ...probe).then(() => true, () => false);
    }, publicationId),
  ]);
  return { gateway: gatewayState, publications };
}

interface FeaturesOpenApi {
  openapi?: string;
  servers?: { url: string }[];
  paths?: Record<string, { get?: FeaturesOperation; post?: FeaturesOperation }>;
  tags?: { name: string }[];
  info?: { title: string; version: string };
  components?: { parameters?: Record<string, FeaturesParameter> };
}

interface FeaturesParameter {
  $ref?: string;
  name?: string;
  in?: string;
  description?: string;
  style?: string;
  explode?: boolean;
  required?: boolean;
  schema?: Record<string, unknown>;
}

interface FeaturesOperation {
  operationId?: string;
  summary?: string;
  tags?: string[];
  description?: string;
  parameters?: FeaturesParameter[];
  responses: Record<string, unknown>;
}

function dataPath(id: string, protocol: Publication['protocol']) {
  return `/collections/${id}/${protocol === 'maps' ? 'map' : protocol === 'tiles' ? 'tiles' : 'items'}`;
}

function checkOpenApi(body: string, publicUrl: string, publications: [string, Publication][]) {
  const api = JSON.parse(body) as FeaturesOpenApi;
  if (!api.openapi?.startsWith('3.0.') || api.servers?.[0]?.url !== publicUrl || !api.paths ||
      publications.some(([id, { protocol }]) => !api.paths?.[dataPath(id, protocol)])) {
    throw new Error('The generated OpenAPI does not match the publication configuration.');
  }
  return api;
}

export async function closeGateway(directory: string) {
  await writeFile(join(directory, 'closed'), '');
}

export async function openGateway(directory: string) {
  await rm(join(directory, 'closed'), { force: true });
}

export async function publicationGrantRemoval({ config, directory }: Revision, planId: string,
  action: 'abort' | { deleteIds: string[] }) {
  if (!/^plan-[a-f0-9]{64}$/.test(planId) ||
      (action !== 'abort' && action.deleteIds.some((id) => !/^[a-z][a-z0-9-]{0,62}$/.test(id)))) {
    throw new Error('Invalid publication removal.');
  }
  const version = `'${planId}'`;
  // The first transaction decides the outcome. A delayed worker cannot delete
  // grants if recovery has already recorded an aborted removal.
  const command = action === 'abort'
    ? `INSERT INTO publication_grant_removal (version, committed) VALUES (${version}, false) ON CONFLICT DO NOTHING;`
    : `
      DO $grant_removal$
      BEGIN
        INSERT INTO publication_grant_removal (version, committed) VALUES (${version}, true) ON CONFLICT DO NOTHING;
        IF FOUND AND to_regclass('public.publication_grant') IS NOT NULL THEN
          DELETE FROM public.publication_grant
            WHERE publication_id IN (${action.deleteIds.map((id) => `'${id}'`).join(', ')});
        END IF;
      END
      $grant_removal$;
    `;
  const output = await compose(config, directory, 'exec', '-T', 'postgres',
    'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-U', 'gis', '-d', 'gis', '-c', `
      BEGIN;
      SELECT pg_advisory_xact_lock(hashtext('gis.publication_grant_removal'));
      CREATE TABLE IF NOT EXISTS publication_grant_removal (version text PRIMARY KEY, committed boolean NOT NULL);
      ${command}
      SELECT committed FROM publication_grant_removal WHERE version = ${version};
      COMMIT;
    `);
  const committed = output.trim();
  if (committed !== 't' && committed !== 'f') throw new Error('The grant removal result is unavailable.');
  return committed === 't';
}

function stackServices(config: FeaturesConfig) {
  const providers = [
    ...(builtInProviderId(config) ? ['pygeoapi'] : []),
    ...Object.keys(config.providers ?? {}).filter((id) => managedProviderRuns(config, id)).map((id) => serviceName(config, id)),
  ];
  return [...providers, ...(config.auth ? ['access', 'postgres', ...(config.auth.mode === 'development' ? ['mailpit'] : [])] : []),
    ...(needsMetadataService(config) ? ['metadata'] : [])];
}

export async function featuresStackRunning(config: FeaturesConfig, directory: string) {
  const running = (await compose(config, directory, 'ps', '--status', 'running', '--services')).trim().split(/\s+/);
  return ['caddy', ...stackServices(config)].every((service) => running.includes(service));
}

export async function startFeaturesStack(config: FeaturesConfig, revisionDirectory: string, confirmed?: Revision) {
  const origin = new URL(config.publicUrl);
  const certificate = config.tls ? await readFile(config.tls.cert_file) : undefined;
  const reusedProviders = new Set<string>();
  if (confirmed) {
    for (const [id, provider] of Object.entries(config.providers ?? {})) {
      if (!managedProviderRuns(config, id) ||
          JSON.stringify(confirmed.config.providers?.[id]) !== JSON.stringify(provider) ||
          providerConfigurationChanged(config, confirmed.config, id)) continue;
      const service = serviceName(config, id);
      if (await nativeProviderDirectory(revisionDirectory, service) === await nativeProviderDirectory(confirmed.directory, service)) {
        reusedProviders.add(id);
      }
    }
  }
  const confirmedMartin = new Set([...reusedProviders].filter((id) => config.providers?.[id]?.type === 'martin'));
  const optionalServices = [...confirmedMartin].map((id) => serviceName(config, id));
  const requiredServices = stackServices(config).filter((service) => !optionalServices.includes(service));
  await compose(config, revisionDirectory, 'up', '-d', '--no-deps',
    ...(!requiredServices.length && !optionalServices.length ? ['--remove-orphans'] : []), 'caddy');
  if (!builtInProviderId(config)) await compose(config, revisionDirectory, 'rm', '-sf', 'pygeoapi');
  if (optionalServices.length) {
    await compose(config, revisionDirectory, 'up', '-d', '--no-deps', '--remove-orphans', ...optionalServices);
  }
  if (requiredServices.length) {
    await compose(config, revisionDirectory, 'up', '-d', '--remove-orphans',
      '--wait', '--wait-timeout', '65', ...(config.auth || config.providers ? ['--build'] : []), ...requiredServices);
  }

  const collections = publicationEntries(config).map(([id, publication]) => ({
    id, ...publication, url: publicationUrl(config, id, publication),
  }));
  const internal = async (path: string, status: number, base = 'http://127.0.0.1:2080', timeout = '3') => {
    try {
      const body = await compose(config, revisionDirectory, 'exec', '-T', 'caddy', 'wget', '-T', timeout, '-S', '-O', '-',
        `${base}${path}`);
      if (status === 200) return body;
    } catch (error) {
      if (status === 401 && error instanceof Error && 'stderr' in error &&
          typeof error.stderr === 'string' && /HTTP\/1\.1 401\b/.test(error.stderr)) return '';
    }
    throw new Error('Candidate gateway returned an unexpected response.');
  };
  for (let attempt = 0; attempt < 15; attempt++) {
    try {
      const gate = await probeCollection(origin, '/features/collections?f=json', certificate);
      if (gate.status !== 503 || gate.cacheControl !== 'no-store') throw new Error('The gateway is not closed.');
      for (const [id, provider] of Object.entries(config.providers ?? {})) {
        if (!provider.image || provider.type !== 'pygeoapi' || reusedProviders.has(id) ||
            provider.api.readiness === '/openapi?f=json' ||
            !publicationsForProvider(config, id).some(([, publication]) => postgisSource(config, publication.source))) continue;
        const { base_path: base, port, readiness } = provider.api;
        await internal((base === '/' ? '' : base) + readiness, 200, `http://${serviceName(config, id)}:${port}`);
      }
      for (const { id, provider, protocol, source, access, url } of collections) {
        const mvt = protocol === 'mvt';
        const path = new URL(url).pathname + (mvt ? '' : '?f=json');
        if (confirmedMartin.has(provider)) {
          if (access !== 'public') await internal(path, 401);
          continue;
        }
        let body = await internal(path, access === 'public' ? 200 : 401);
        let tileJsonUrl = url;
        if (config.providers && access !== 'public') {
          const instance = config.providers[provider];
          const api = instance?.image ? instance.api : undefined;
          const base = api?.base_path === '/' ? '' : api?.base_path ?? '';
          const nativeOrigin = `http://${serviceName(config, provider)}:${api?.port ?? 80}`;
          body = await internal(`${base}${mvt ? `/${id}` : `/collections/${id}?f=json`}`, 200, nativeOrigin);
          tileJsonUrl = nativeOrigin + path;
        }
        if (body) {
          if (mvt) {
            checkTileJson(body, tileJsonUrl, id, postgisSource(config, source)?.id_field);
            continue;
          }
          const collection = JSON.parse(body) as { id?: string; links?: { rel: string; href: string }[] };
          const [relation, suffix] = protocol === 'maps' ? [mapRelation, 'map?f=png'] :
            protocol === 'tiles' ? [tilesRelation, 'tiles?f=json'] : ['items', 'items?f=json'];
          if (collection.id !== id || !collection.links?.some(({ rel, href }) =>
            rel === relation && href === `${url}/${suffix}`)) {
            throw new Error('Unexpected collection or canonical URL.');
          }
        }
      }
      const roots = new Set(Object.keys(config.providers ?? {}).map((id) => providerRoot(config, id)));
      if (!roots.size) roots.add('/features');
      for (const root of roots) {
        if (root === '/mvt') continue;
        const visible = publicationEntries(config).filter(([, { access, provider }]) =>
          access === 'public' && providerRoot(config, provider) === root);
        const api = checkOpenApi(await internal(`${root}/openapi?f=json`, 200), new URL(root, origin).href, visible);
        if (config.providers) {
          // Catalog entries include a bounded live source check.
          const catalog = JSON.parse(await internal(`${root}/collections?f=json`, 200, undefined, '8')) as {
            collections: { id: string }[];
          };
          for (const { id, access, protocol, provider } of collections) {
            if (providerRoot(config, provider) === root &&
                (catalog.collections.some((item) => item.id === id) !== (access === 'public') ||
                 Boolean(api.paths?.[dataPath(id, protocol)]) !== (access === 'public'))) {
              throw new Error('The candidate metadata does not match the publication access rules.');
            }
          }
        }
      }
      return;
    } catch (error) {
      if (attempt === 14) throw error;
    }
    await setTimeout(500);
  }
}
