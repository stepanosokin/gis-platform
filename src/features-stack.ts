import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { get as getHttp } from 'node:http';
import { get as getHttps } from 'node:https';
import { isIP } from 'node:net';
import { basename, extname, join } from 'node:path';
import { text } from 'node:stream/consumers';
import { setTimeout } from 'node:timers/promises';
import { checkServerIdentity, createSecureContext, TLSSocket } from 'node:tls';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { parse, stringify } from 'yaml';
import { mapBboxDescription, mapRelation, mapSize } from './maps-profile.js';
import { checkTileJson, martinConfig, martinService, runMartin, tileArchivePath } from './martin-profile.js';
import { matrixSet, tilesRoutes, tilesRelation, tilesSource, vectorTileType } from './tiles-profile.js';
import { mapLibreAssetRoute } from './maplibre-style.js';
import { featuresConformance, protocolConformance } from './protocol-conformance.js';
import { dggsConfig, dggsDataRoute, dggsFiles, dggsRelation, dggsRoutes, dggsService,
  dggsSnapshotPath, dggsZoneParameters, runDggs } from './dggs-profile.js';
import { healthUrl, publicationChecks, publicationHealth } from './publication-health.js';
import { GatewayTlsError, gatewayTlsFiles, gatewayTlsProbe, inspectGatewayTls } from './gateway-tls.js';
import { builtInProviderId, hasGeoJson, hasProtocolMetadata, managedProviderRuns, needsMetadataService, pinnedImage,
  postgisConnectionsForProvider, postgisSecretName, postgisSource,
  providerBasePath, providerProtocols, providerRoot, providerRoutes, providerServiceName as serviceName, publicationEntries, publicationRoot, publicationsForProvider,
  publicationUrl, crs84, rasterFile, tileArchive, usedFileSources, vectorFile, type FeaturesConfig, type FileSource, type Publication } from './config.js';

const run = promisify(execFile);
const composeFile = (name: string) => fileURLToPath(new URL(`../${name}`, import.meta.url));
const postgisPlugin = 'gis_postgis.PostGISProvider';
const vectorFilePlugin = 'gis_vector_files.VectorFileProvider';
const parquetImage = 'gis-platform-pygeoapi-parquet:0.24.0-arrow-23.0.1';
const apiNames = { features: 'Features', maps: 'Maps', tiles: 'Tiles', mvt: 'MVT', dggs: 'DGGS' };
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
  const provider = instance ? config.providers?.[instance] : undefined;
  const protocols = providerProtocols(provider);
  const publicUrl = instance ? new URL(providerRoot(config, instance, protocols[0]!), config.publicUrl).href : config.publicUrl;
  const protocol = protocols.map((name) => apiNames[name]).join(', ');
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
  const connection = config.postgisConnections?.[source.connection];
  if (!connection) throw new Error('The PostGIS connection is missing.');
  const { host, port, database, user } = connection;
  return {
    type: 'feature',
    name: postgisPlugin,
    data: { host, port, dbname: database, user, search_path: [source.schema] },
    password_file: `/run/secrets/${postgisSecretName(source.connection)}`,
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
  if (id !== undefined && serviceName(candidate, id) !== serviceName(previous, id)) return true;
  if (id !== undefined && JSON.stringify(usedFileSources(candidate, id)) !== JSON.stringify(usedFileSources(previous, id))) {
    return true;
  }
  if (id !== undefined && JSON.stringify(postgisConnectionsForProvider(candidate, id)) !==
      JSON.stringify(postgisConnectionsForProvider(previous, id))) return true;
  if (id && candidate.providers?.[id]?.type === 'martin') {
    return JSON.stringify(martinConfig(candidate, id)) !== JSON.stringify(martinConfig(previous, id));
  }
  if (id && candidate.providers?.[id]?.type === 'pydggsapi') {
    return previous.providers?.[id]?.type !== 'pydggsapi' ||
      providerRoot(candidate, id, 'dggs') !== providerRoot(previous, id, 'dggs') ||
      JSON.stringify(dggsConfig(candidate, id)) !== JSON.stringify(dggsConfig(previous, id));
  }
  return (id !== undefined && (hasGeoJson(candidate, id) || hasGeoJson(previous, id)) &&
    candidate.sourcePath !== previous.sourcePath) ||
    JSON.stringify(pygeoapiConfig(candidate, id)) !== JSON.stringify(pygeoapiConfig(previous, id));
}

function caddyConfig(config: FeaturesConfig) {
  const { host, hostname, origin, protocol, port } = new URL(config.publicUrl);
  const site = config.tls ? `https://${hostname}:443` : ':80';
  const tlsOptions = config.tls ? '\n\tauto_https disable_redirects' : '';
  const certificate = config.tls ? '\n\ttls /run/secrets/tls_cert /run/secrets/tls_key' : '';
  const redirect = config.tls ? `
http://:80 {
	header Cache-Control no-store
	redir ${origin}{uri} 308
}
` : '';
  const publications = publicationEntries(config);
  const protectedIds = publications.filter(([, publication]) => publication.access !== 'public').map(([id]) => id);
  const publicIds = publications.filter(([, publication]) => publication.access === 'public').map(([id]) => id);
  const ogcRoutes = { maps: 'map', features: 'schema|queryables|items(/.+)?', tiles: tilesRoutes, dggs: dggsRoutes };
  const collectionRoute = (ids: string[], protocol?: Publication['protocol']) =>
    protocol === 'mvt' ? `(${ids.join('|')})(/[0-9]{1,2}/[0-9]{1,10}/[0-9]{1,10})?` :
    `collections/(${ids.join('|')})(/(${protocol ? ogcRoutes[protocol] : Object.values(ogcRoutes).join('|')}))?`;
  const ogcIds = publications.filter(([, publication]) => publication.protocol !== 'mvt').map(([id]) => id);
  const byProtocol = providerRoutes(config);
  const mvtRoots = [...byProtocol].filter(([, { protocol }]) => protocol === 'mvt').map(([root]) => root);
  const tileRoot = mvtRoots.length ? `(?:${mvtRoots.join('|')})` : '/mvt';
  const mvtIds = publications.filter(([, publication]) => publication.protocol === 'mvt').map(([id]) => id);
  const allCollections = ogcIds.length ? collectionRoute(ogcIds) : '';
  const allTiles = mvtIds.length ? `${tileRoot}/${collectionRoute(mvtIds, 'mvt')}` : '';
  const styledIds = publications.filter(([, publication]) => publication.maplibre).map(([id]) => id);
  const mapLibreAssets = styledIds.length ? `${tileRoot}/(${styledIds.join('|')})/${mapLibreAssetRoute}` : '';
  const mapRoutes = [allTiles, mapLibreAssets].filter(Boolean).join('|');
  const roots = [...byProtocol.keys()];
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
				import gis_public_headers
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
				import gis_public_headers
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
				import gis_public_headers
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
			import gis_public_headers
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

(gis_public_headers) {
	header_up Host ${host}
	header_up X-Forwarded-Host ${host}
	header_up X-Forwarded-Proto ${protocol.slice(0, -1)}
	header_up X-Forwarded-Port ${port || (config.tls ? '443' : '80')}
	header_up -Forwarded
}

${site} {${certificate}
${journal}
	route {
		header -Strict-Transport-Security
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
${redirect}

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
  for (const [root, route] of providerRoutes(config)) {
    const { protocol, ids, nested } = route;
    const rootIndex = routes.length;
    const entries = publications.filter(([, publication]) => publicationRoot(config, publication) === root);
    const mvt = protocol === 'mvt';
    const dggs = protocol === 'dggs';
    const tiles = protocol === 'tiles';
    const rootProvider = (tiles && entries[0]?.[1].provider) || ids[0];
    const metadata = config.auth ? 'access' : 'metadata';
    const managedConformance = nested || entries.some(([, publication]) => vectorFile(config, publication.source));
    if (mvt && nested) {
      routes.push(corsRoutes(`cors${rootIndex}`, `path_regexp ^${root}(/?|/catalog|/openapi|/conformance)$`, origins));
    } else if (tiles || dggs) {
      const paths = ['/?', '/collections', '/openapi',
        '/conformance', ...(dggs ? ['/docs'] : ['/[Tt]ileMatrixSets(/[^/]+)?'])];
      if (entries.length) paths.push('/' + collectionRoute(entries.map(([id]) => id), dggs ? 'dggs' : 'tiles'));
      routes.push(corsRoutes(`cors${rootIndex}`, `path_regexp ^${root}(${paths.join('|')})$`, origins));
    }
    if (hasProtocolMetadata(route)) routes.push(`
	@metadata${rootIndex} {
		method GET HEAD
		path ${root}/${mvt ? 'catalog' : 'collections'} ${root}/openapi${dggs || mvt ? ` ${root} ${root}/` : ''}${managedConformance || mvt ? ` ${root}/conformance` : ''}
	}
	handle @metadata${rootIndex} {
		route {${metadataFallback ? '\n			vars public_metadata true' : ''}
			reverse_proxy ${metadata}:3000 {
				import gis_public_headers
				header_up X-GIS-Request-Id {http.request.uuid}
			}
		}
	}
`);
    for (const id of ids) {
      const providerEntries = entries.filter(([, entry]) => entry.provider === id);
      const instance = config.providers?.[id];
      const api = instance?.image ? instance.api : undefined;
      const maps = protocol === 'maps';
      const mapPath = `${root}/collections/*/map`;
      const mapRequest = maps ? `forward_auth ${mapPath} metadata:3000 {
				uri /internal/validate-map
				import gis_public_headers
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
      const base = providerBasePath(config, id);
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
      const proxy = (postgis = false, swagger = false) => `${mapRequest}${tileAccept}${dggs && !swagger ? dggsRequest(root) : ''}${postgis ? tileJsonChecks : ''}
			${dggs ? '' : `uri strip_prefix ${root}`}
			${tiles ? 'uri replace /tileMatrixSets /TileMatrixSets' : ''}
			${!dggs && (base || mvt) ? `rewrite * ${base}{http.request.uri.path}${mvt ? '?' : ''}` : ''}
			reverse_proxy ${upstream} {
				import gis_public_headers
				${instance?.type === 'pygeoapi' && api?.protocols ? `header_up X-GIS-Protocol ${protocol}` : ''}
				${postgis || tiles ? `transport http {
					response_header_timeout 15s
				}` : ''}
				header_up -Cookie
				header_up -Authorization
				header_down Cache-Control no-store${swagger ? '' : htmlPolicy}${postgis || mvt || maps || dggs ? `
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
		path ${dggs ? `${root}/docs` : `${root} ${root}/ ${root}/static/*${managedConformance ? '' : ` ${root}/conformance`}${tiles ?
          ` ${root}/TileMatrixSets ${root}/tileMatrixSets ${root}/TileMatrixSets/*` : ''}`}
	}
	handle @root${rootIndex} {
		route {${tiles ? `
			@tilesLanding path ${root}
			rewrite @tilesLanding ${root}/` : ''}
			${proxy(false, dggs)}
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
				import gis_public_headers
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
		path_regexp ${name} ^${root}/${collectionRoute(visible, protocol)}$`);
          if (postgis && protocol === 'features') addPublicationRoute(anonymous, proxy(true), (name) => `method POST
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
			reverse_proxy metadata:3000 {
				import gis_public_headers
			}
		}`);
  return { routes: routes.join('\n'), fallback: fallback.join('\n') };
}

interface Revision {
  config: FeaturesConfig;
  directory: string;
  tlsFingerprint?: string | null;
}

// The native Parquet provider builds projection and filter SQL from its broader
// query interface. Only the parameters of the accepted H3 profile reach it.
const rawQuery = '{http.request.uri.query}';
const dggsQueryParameter = `(${dggsZoneParameters.map(({ name, pattern }) => `${name}=${pattern}`).join('|')})`;
const invalidDggsListQuery = [
  `!${rawQuery}.matches('^${dggsQueryParameter}(&${dggsQueryParameter})*$')`,
  ...dggsZoneParameters.filter(({ required }) => required).map(({ name }) => `!${rawQuery}.matches('(^|&)${name}=')`),
  ...dggsZoneParameters.map(({ name }) => `${rawQuery}.matches('(^|&)${name}=.*&${name}=')`),
].join(' || ');
const dggsRequest = (root: string) => `
			header >Cache-Control no-store
			@dggsZoneListInvalid {
				path_regexp ^${root}/collections/[^/]+${dggsDataRoute}$
				expression \`${invalidDggsListQuery}\`
			}
			@dggsZoneDataInvalid {
				path_regexp ^${root}/collections/[^/]+${dggsDataRoute}/[^/]+/data$
				expression \`!{http.request.uri.query}.matches('^(zone-depth=0)?$')\`
			}
			respond @dggsZoneListInvalid 400
			respond @dggsZoneDataInvalid 400
			@dggsMetadata {
				not path_regexp ^${root}/collections/[^/]+${dggsDataRoute}(/[^/]+/data)?$
			}
			rewrite @dggsMetadata {http.request.uri.path}?
			@dggsNoAccept expression \`{http.request.header.Accept} == ""\`
			request_header @dggsNoAccept Accept */*
			@dggsGeoJson {
				path_regexp ^${root}/collections/[^/]+${dggsDataRoute}$
				query f=geojson
			}
			request_header @dggsGeoJson Accept application/geo+json
			`;

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

export function fileParts(id: string, source: FileSource) {
  if (source.type === 'parquet') {
    return [{ path: source.path, target: dggsSnapshotPath(id), optional: false }];
  }
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
    const label = tileArchive(config, id) ? 'Tile archive' : rasterFile(config, id) ? 'Raster file' :
      config.dggsSources?.[id] ? 'DGGS snapshot' : 'Vector file';
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
    const connections = postgisConnectionsForProvider(config, id);
    const connection = connections.length ? connections.map(([name, { password_file }]) => {
      const secret = postgisSecretName(name);
      secrets[secret] = { file: escapeCompose(password_file) };
      return { source: secret };
    }) : undefined;
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
      const serviceSettings = martinService(provider, escapeCompose(await nativeProviderDirectory(directory, service)), connections, connection);
      services[service] = { ...serviceSettings, volumes: [...serviceSettings.volumes, ...fileMounts] };
      continue;
    }
    if (provider.type === 'pydggsapi') {
      await writeFile(join(native, 'config.json'), JSON.stringify(dggsConfig(config, id)));
      await writeFile(join(native, 'run.sh'), runDggs);
      await copyFile(fileURLToPath(new URL('../src/validate_dggs_snapshot.py', import.meta.url)), join(native, 'validate.py'));
      const settings = dggsService(provider, providerRoot(config, id, 'dggs'),
        escapeCompose(await nativeProviderDirectory(directory, service)));
      services[service] = { ...settings, volumes: [...settings.volumes, ...fileMounts] };
      continue;
    }
    const protocols = providerProtocols(provider);
    const tiles = protocols.includes('tiles');
    const nested = Boolean(provider.image && provider.api.protocols);
    const pluginEnvironment = connection || vectorFiles || tiles || nested ? {
      PYTHONPATH: '/etc/pygeoapi/gis' + (provider.image && provider.environment?.PYTHONPATH
        ? `:${escapeCompose(provider.environment.PYTHONPATH)}` : ''),
    } : undefined;
    if (vectorFiles) {
      await copyFile(fileURLToPath(new URL('../src/gis_vector_files.py', import.meta.url)), join(native, 'gis_vector_files.py'));
    }
    if (connection) {
      await copyFile(fileURLToPath(new URL('../src/gis_postgis.py', import.meta.url)), join(native, 'gis_postgis.py'));
    }
    if (tiles) {
      await copyFile(fileURLToPath(new URL('../src/gis_tiles.py', import.meta.url)), join(native, 'gis_tiles.py'));
    }
    if (nested) {
      await copyFile(fileURLToPath(new URL('../src/gis_pygeoapi.py', import.meta.url)), join(native, 'gis_pygeoapi.py'));
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
    const profiles = Object.fromEntries(protocols.map((protocol) => [protocol, {
      url: new URL(providerRoot(config, id, protocol), config.publicUrl).href,
      name: apiNames[protocol],
      collections: publicationEntries(config).filter(([, publication]) =>
        publication.provider === id && publication.protocol === protocol).map(([key]) => key),
    }]));
    const namedVolumes = Object.entries(provider.volumes ?? {}).map(([name, target]) => {
      const volume = `provider-${id}_${name}`;
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
        ...(nested && { GIS_PYGEOAPI_PROTOCOLS: JSON.stringify(profiles) }),
        ...pluginEnvironment,
        ...(base !== '/' && { SCRIPT_NAME: base }),
      },
      entrypoint: ['/venv/bin/gunicorn'],
      command: ['--workers', '1', '--worker-class', 'gevent', '--timeout', '6000',
        '--bind', `0.0.0.0:${port}`, nested ? 'gis_pygeoapi:APP' : 'pygeoapi.flask_app:APP'],
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
  const documents: Record<string, { url: string; api: FeaturesOpenApi; tiles?: Record<string, { content_type: string }> }> = {};
  const providers = Object.keys(config.providers ?? {});
  const entries = publicationEntries(config);
  for (const id of providers) {
    const instance = config.providers?.[id];
    const protocols = providerProtocols(instance);
    const root = providerRoot(config, id, protocols[0]!);
    const url = new URL(root, config.publicUrl).href;
    const service = serviceName(config, id);
    const publications = entries.filter(([, pub]) => pub.provider === id);
    const native = service === 'pygeoapi' ? directory : join(directory, service);
    const mounted = await nativeProviderDirectory(directory, service);
    if (instance?.type === 'martin') {
      const rendered = publicationsForProvider(config, id);
      let catalog: Record<string, { content_type: string }> = {};
      if (rendered.length && mounted === native) {
        try {
          const output = await compose(config, directory, 'run', '--rm', '--no-deps', '-T', service,
            '--check', ...rendered.map(([key]) => key));
          const [catalogJson, ...documents] = output.trim().split('\n');
          const { tiles } = JSON.parse(catalogJson ?? '') as { tiles: typeof catalog };
          catalog = tiles;
          for (const [index, [key, publication]] of rendered.entries()) {
            const source = postgisSource(config, publication.source);
            const contentType = tiles[key]?.content_type;
            const vectorArchive = contentType === 'application/x-protobuf';
            if (!source && !vectorArchive && !contentType?.startsWith('image/')) {
              throw new Error(`Publication '${key}' has an unsupported tile format.`);
            }
            const archiveLayers = vectorArchive ? 'vector' : 'raster';
            checkTileJson(documents[index] ?? '', `http://127.0.0.1:${instance.api.port}${root}/${key}`, key,
              source ? { idField: source.id_field } : archiveLayers);
          }
        } catch {
          const postgisCount = rendered.filter(([, publication]) => postgisSource(config, publication.source)).length;
          if (postgisCount === 0) {
            throw new FeaturesPreflightError(`Martin provider '${id}' failed to open its tile archives. Check the tile format and TileJSON.`);
          }
          if (postgisCount < rendered.length) {
            throw new FeaturesPreflightError(`Martin provider '${id}' failed to check its PostGIS sources and tile archives. Check connectivity, access, tile formats and TileJSON.`);
          }
          throw new FeaturesPreflightError(`Martin provider '${id}' failed to open its PostGIS sources. Check connectivity, access and source definitions.`);
        }
      }
      if (instance.api.protocols) {
        const filename = 'martin-catalog.json';
        if (rendered.length && mounted !== native) catalog = JSON.parse(await readFile(join(mounted, filename), 'utf8'));
        else if (rendered.length) await writeFile(join(native, filename), JSON.stringify(catalog));
        documents[root] = { url, api: martinOpenApi(url, publications, catalog), tiles: catalog };
      }
      continue;
    }
    let api: FeaturesOpenApi;
    if (mounted !== native) {
      api = checkOpenApi(await readFile(join(mounted, 'openapi.json'), 'utf8'), url, publications,
        instance?.type === 'pydggsapi' ? '3.1.' : '3.0.');
    } else if (instance?.type === 'pydggsapi') {
      const output = await compose(config, directory, 'run', '--rm', '--no-deps', '-T', service, '--check')
        .catch((error: unknown) => {
          const failure = error instanceof Error && 'stderr' in error && typeof error.stderr === 'string'
            ? /^GIS_INVALID_DGGS_SNAPSHOT ([a-z][a-z0-9-]*)\r?$/m.exec(error.stderr) : null;
          throw new FeaturesPreflightError(failure
            ? `Invalid DGGS snapshot '${failure[1]}'. Check the H3 IDs, resolution, column names and BIGINT or DOUBLE indicators.`
            : `pydggsapi provider '${id}' failed to initialize. Check the pinned image and its DuckDB extension.`);
        });
      api = dggsOpenApi(output, root, url, publications);
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
    if (protocols.includes('tiles')) {
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
    for (const protocol of protocols) {
      const publicRoot = providerRoot(config, id, protocol);
      const publicUrl = new URL(publicRoot, config.publicUrl).href;
      const scoped = instance?.image && instance.api.protocols ? protocolOpenApi(api, publicUrl, protocol,
        new Set(publications.filter(([, publication]) => publication.protocol === protocol).map(([key]) => key))) : api;
      const shared = documents[publicRoot];
      if (shared) {
        Object.assign(shared.api.paths!, Object.fromEntries(Object.entries(scoped.paths ?? {}).filter(([key]) =>
          key.startsWith('/collections/'))));
        shared.api.tags = [...(shared.api.tags ?? []), ...(scoped.tags ?? []).filter(({ name }) => name !== 'server')];
      } else {
        documents[publicRoot] = { url: publicUrl, api: scoped };
      }
    }
  }
  if (!providers.length) {
    documents['/features'] = { url: config.publicUrl, api: {
      openapi: '3.0.2', servers: [{ url: config.publicUrl }], info: { title: 'GIS Platform Features', version: '1' },
      components: {}, paths: {},
    } };
  }
  const routes = providerRoutes(config);
  const roots = Object.fromEntries(Object.entries(documents).map(([root, { url, api, tiles }]) => {
    const { protocol, nested } = routes.get(root)!;
    const publications = entries.filter(([, publication]) => publicationRoot(config, publication) === root);
    return [root, {
      url, api,
      tileCatalog: tiles && Object.fromEntries(publications.map(([id, publication]) => [id, {
      name: publication.title, description: publication.description, content_type: tiles[id]!.content_type,
      tilejson: `${url}/${id}`,
      }])),
      ...(nested ? { conformance: protocolConformance(config, protocol, publications) } : {
        conformsTo: publications.some(([, publication]) => vectorFile(config, publication.source))
          ? featuresConformance(publications.some(([, publication]) => postgisSource(config, publication.source))) : undefined,
      }),
      sourceProbes: Object.fromEntries(publications.filter(([, publication]) =>
        postgisSource(config, publication.source) || publication.protocol === 'dggs')
        .map(([id, publication]) => [id, publicationHealth(config, id, publication).source])),
      collections: publications.map(([id, publication]) => ({
        id, title: publication.title, description: publicationDescription(config, publication),
        ...(publication.protocol === 'features' && { crs: publication.crs ?? [crs84], storageCrs: crs84 }), extent: {
          spatial: { bbox: [publication.extent], crs: crs84 },
          ...(publication.time_field && { temporal: { interval: [[null, null]] } }),
        },
        links: (publication.protocol === 'dggs' ? [{ rel: 'self', href: `${url}/collections/${id}`,
          type: 'application/json' }] : ['json', 'html', 'jsonld'].map((format) => ({
          rel: 'self', href: `${url}/collections/${id}?f=${format}`,
          type: ({ json: 'application/json', html: 'text/html', jsonld: 'application/ld+json' })[format],
        }))).concat(publication.protocol === 'maps'
          ? [{ rel: mapRelation, href: `${url}/collections/${id}/map?f=png`, type: 'image/png' }]
          : publication.protocol === 'tiles'
          ? [{ rel: tilesRelation, href: `${url}/collections/${id}/tiles?f=json`, type: 'application/json' }]
          : publication.protocol === 'dggs'
          ? [{ rel: dggsRelation, href: `${url}/collections/${id}/dggs`, type: 'application/json' }]
          : [{ rel: 'items', href: `${url}/collections/${id}/items?f=json`, type: 'application/geo+json' }]),
      })),
    }];
  }));
  await writeFile(join(directory, 'features.json'), JSON.stringify(roots));
  if (savedHash) await writeFile(join(directory, 'source.sha256'), savedHash);
}

function martinOpenApi(url: string, publications: [string, Publication][], catalog: Record<string, { content_type: string }>): FeaturesOpenApi {
  const paths: NonNullable<FeaturesOpenApi['paths']> = {
    '/': { get: { responses: { '200': { description: 'Tile service links' } } } },
    '/catalog': { get: { responses: { '200': { description: 'Available tile sources' } } } },
    '/openapi': { get: { responses: { '200': { description: 'OpenAPI definition' } } } },
    '/conformance': { get: { responses: { '200': { description: 'Supported tile interfaces' } } } },
  };
  for (const [id, publication] of publications) {
    paths[`/${id}`] = { get: { summary: publication.title, tags: [id], responses: { '200': {
      description: 'TileJSON', content: { 'application/json': { schema: { type: 'object' } } },
    } } } };
    paths[`/${id}/{z}/{x}/{y}`] = { get: { tags: [id],
      parameters: ['z', 'x', 'y'].map((name) => ({ name, in: 'path', required: true, schema: { type: 'integer', minimum: 0 } })),
      responses: { '200': { description: 'XYZ tile', content: {
        [catalog[id]!.content_type]: { schema: { type: 'string', format: 'binary' } },
      } }, '204': { description: 'No tile data' } },
    } };
    if (publication.maplibre) {
      paths[`/${id}/style.json`] = { get: { tags: [id], responses: { '200': { description: 'MapLibre style' } } } };
    }
  }
  return { openapi: '3.0.2', servers: [{ url }], info: { title: 'GIS Platform MVT', version: '1' },
    paths, tags: publications.map(([name]) => ({ name })), components: {} };
}

function protocolOpenApi(api: FeaturesOpenApi, url: string, protocol: Publication['protocol'], ids: Set<string>) {
  const paths = Object.fromEntries(Object.entries(api.paths ?? {}).filter(([path]) => {
    if (path.startsWith('/TileMatrixSets')) return protocol === 'tiles';
    const id = /^\/collections\/([^/]+)/.exec(path)?.[1];
    return !id || ids.has(id);
  }));
  const components = structuredClone(api.components);
  const resourceId = components?.parameters?.resourceId?.schema;
  const id = ids.values().next().value;
  if (resourceId && id) resourceId.default = id;
  else if (resourceId) delete resourceId.default;
  return { ...api, servers: [{ url }], paths, components,
    info: { version: api.info?.version ?? '1', title: `GIS Platform ${apiNames[protocol]}`,
      description: `OGC API ${apiNames[protocol]} collections`, termsOfService: url,
      contact: { name: 'GIS Platform', url }, license: { name: 'Data license unspecified', url } },
    tags: api.tags?.filter(({ name }) => name === 'server' || ids.has(name)),
  };
}

async function nativeProviderDirectory(directory: string, service = 'pygeoapi') {
  const native = service === 'pygeoapi' ? directory : join(directory, service);
  const revision = await readFile(join(native, 'provider-directory'), 'utf8').catch(() => undefined);
  if (!revision || !/^plan-[a-f0-9]{64}$/.test(revision)) return native;
  return service === 'pygeoapi' ? join(directory, '..', revision) : join(directory, '..', revision, service);
}

export function compose(config: FeaturesConfig, directory: string, ...args: string[]) {
  return composeRevision({ config, directory }, ...args);
}

async function composeRevision({ config, directory: revisionDirectory, tlsFingerprint }: Revision, ...args: string[]) {
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
  const tls = await gatewayTlsFiles(config, revisionDirectory, tlsFingerprint !== undefined);
  const { stdout } = await run('docker', ['compose', ...(project ? ['-p', project] : []),
    ...files.flatMap((file) => ['-f', file]), ...args], {
    env: {
      ...process.env,
      GIS_PUBLIC_PORT: String(config.port),
      GIS_CADDY_PORT: config.tls ? '443' : '80',
      GIS_TLS_CERT_FILE: tls?.files.cert_file,
      GIS_TLS_KEY_FILE: tls?.files.key_file,
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

function probeCollection(origin: URL, path: string, tls: Awaited<ReturnType<typeof gatewayTlsProbe>>,
  rejectUnauthorized = true) {
  return new Promise<{ status?: number; cacheControl?: string; body: string }>((resolve, reject) => {
    const url = new URL(path, origin);
    url.hostname = '127.0.0.1';
    const get = tls ? getHttps : getHttp;
    const request = get(url, {
      agent: false,
      headers: { Host: origin.host },
      signal: AbortSignal.timeout(2000),
      ...(tls && {
        ca: tls.ca,
        allowPartialTrustChain: tls.allowPartialTrustChain,
        rejectUnauthorized,
        ...(isIP(origin.hostname) === 0 && { servername: origin.hostname }),
        checkServerIdentity: (_hostname, peer) => checkServerIdentity(origin.hostname, peer),
      }),
    }, (response) => {
      if (tls && (!(response.socket instanceof TLSSocket) ||
          response.socket.getPeerCertificate().fingerprint256 !== tls.fingerprint)) {
        response.resume();
        reject(new Error('The gateway is serving a different TLS certificate.'));
        return;
      }
      text(response).then((body) => resolve({ status: response.statusCode,
        cacheControl: response.headers['cache-control'], body }), reject);
    });
    request.on('error', reject);
  });
}

export async function verifyLegacyGatewayTls({ config, directory, tlsFingerprint }: Revision) {
  if (!config.tls || tlsFingerprint !== undefined) return;
  try {
    const tls = await gatewayTlsProbe(config, directory);
    const running = await compose(config, directory, 'ps', '--status', 'running', '--services', 'caddy');
    // An expired certificate can still identify the pair that must be retained for a legacy revision.
    if (running.trim()) await probeCollection(new URL(config.publicUrl), '/', tls, false);
  } catch {
    throw new GatewayTlsError('previous-files-unavailable',
      'Keep the previous TLS certificate and key at their original paths for recovery and rollback. Use new paths for the replacement.');
  }
}

export async function diagnoseStack({ config, directory, tlsFingerprint }: Revision, publicationId?: string) {
  const entries = Object.fromEntries(publicationEntries(config)
    .map(([id, publication]) => [id, publicationHealth(config, id, publication)]));
  const gateway = async () => {
    try {
      const { status, cacheControl } = await probeCollection(new URL(config.publicUrl), '/',
        await gatewayTlsProbe(config, directory, tlsFingerprint));
      if (cacheControl === 'no-store') {
        if (status === 404) return 'ready';
        if (status === 503) return 'closed';
      }
    } catch {
      // Diagnostic results do not include connection details.
    }
    return 'unavailable';
  };
  const [gatewayState, tls, publications] = await Promise.all([
    gateway(),
    inspectGatewayTls(config, directory, tlsFingerprint),
    publicationChecks(entries, (endpoint) => {
      const url = healthUrl(endpoint, '127.0.0.1');
      const probe = endpoint.martin
        ? ['wget', '-q', '-T', '3', '-O', '/dev/null', url]
        : [endpoint.python ?? '/venv/bin/python', '-c',
          'import sys; from urllib.request import urlopen; urlopen(sys.argv[1], timeout=3).close()', url];
      return compose(config, directory, 'exec', '-T', endpoint.service, ...probe).then(() => true, () => false);
    }, publicationId),
  ]);
  return { gateway: gatewayState, tls: tls?.state === 'ready' && gatewayState === 'unavailable'
    ? { ...tls, state: 'gateway-unavailable' } : tls, publications };
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
  if (protocol === 'mvt') return `/${id}/{z}/{x}/{y}`;
  if (protocol === 'dggs') return `/collections/${id}${dggsDataRoute}`;
  return `/collections/${id}/${protocol === 'maps' ? 'map' : protocol === 'tiles' ? 'tiles' : 'items'}`;
}

function dggsOpenApi(body: string, root: string, publicUrl: string, publications: [string, Publication][]) {
  const native = JSON.parse(body) as FeaturesOpenApi;
  const paths: NonNullable<FeaturesOpenApi['paths']> = {};
  const queryParameters = dggsZoneParameters.map(({ name, required, description, schema }) =>
    ({ name, in: 'query', required, description, schema }));
  for (const [id] of publications) {
    for (const suffix of ['', '/schema', '/queryables', '/dggs', '/dggs/h3', dggsDataRoute,
      `${dggsDataRoute}/{zoneId}`, `${dggsDataRoute}/{zoneId}/data`]) {
      const path = `/collections/${id}${suffix}`;
      const template = suffix.replace('/dggs/h3', '/dggs/{dggrsId}');
      const operation = native.paths?.[`${root}/collections/{collectionId}${template}`]?.get;
      if (!operation) throw new FeaturesPreflightError(`pydggsapi is missing operation '${path}'.`);
      paths[path] = { get: {
        ...operation,
        operationId: `${id}.${operation.operationId}`,
        tags: [id],
        parameters: [
          ...(operation.parameters ?? []).filter(({ in: location, name }) => location === 'path' && name === 'zoneId'),
          ...(suffix === dggsDataRoute ? queryParameters : suffix.endsWith('/data') ? [{
            name: 'zone-depth', in: 'query', schema: { type: 'integer', enum: [0], default: 0 },
          }] : []),
        ],
      } };
    }
  }
  const api = { ...native, paths, servers: [{ url: publicUrl }], tags: publications.map(([name]) => ({ name })) };
  return checkOpenApi(JSON.stringify(api), publicUrl, publications, '3.1.');
}

function checkOpenApi(body: string, publicUrl: string, publications: [string, Publication][], version = '3.0.') {
  const api = JSON.parse(body) as FeaturesOpenApi;
  if (!api.openapi?.startsWith(version) || api.servers?.[0]?.url !== publicUrl || !api.paths ||
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

export async function startFeaturesStack(revision: Revision, confirmed?: Revision) {
  const { config, directory: revisionDirectory, tlsFingerprint } = revision;
  const origin = new URL(config.publicUrl);
  const tls = await gatewayTlsProbe(config, revisionDirectory, tlsFingerprint);
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
  await composeRevision(revision, 'up', '-d', '--no-deps',
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
  const internal = async (path: string, status: number, base = 'http://127.0.0.1:2080', timeout = '3',
    headers: string[] = []) => {
    try {
      const body = await compose(config, revisionDirectory, 'exec', '-T', 'caddy', 'wget', '-T', timeout, '-S', '-O', '-',
        ...headers.map((header) => `--header=${header}`), `${base}${path}`);
      if (status === 200) return body;
    } catch (error) {
      if (status === 401 && error instanceof Error && 'stderr' in error &&
          typeof error.stderr === 'string' && /HTTP\/1\.1 401\b/.test(error.stderr)) return '';
    }
    throw new Error('Candidate gateway returned an unexpected response.');
  };
  for (let attempt = 0; attempt < 15; attempt++) {
    try {
      const gate = await probeCollection(origin, '/features/collections?f=json', tls);
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
        const dggs = protocol === 'dggs';
        const path = new URL(url).pathname + (mvt || dggs ? '' : '?f=json');
        if (confirmedMartin.has(provider)) {
          if (access !== 'public') await internal(path, 401);
          continue;
        }
        let body = await internal(path, access === 'public' ? 200 : 401);
        let tileJsonUrl = url;
        if (config.providers && access !== 'public') {
          const instance = config.providers[provider];
          const api = instance?.image ? instance.api : undefined;
          const base = providerBasePath(config, provider);
          const nativeOrigin = `http://${serviceName(config, provider)}:${api?.port ?? 80}`;
          body = await internal(`${base}${mvt ? `/${id}` : `/collections/${id}${dggs ? '' : '?f=json'}`}`, 200, nativeOrigin,
            '3', dggs ? [`Host: ${origin.host}`, `X-Forwarded-Proto: ${origin.protocol.slice(0, -1)}`] :
              instance?.type === 'pygeoapi' && api?.protocols ? [`X-GIS-Protocol: ${protocol}`] : []);
          tileJsonUrl = nativeOrigin + path;
        }
        if (body) {
          if (mvt) {
            const postgis = postgisSource(config, source);
            checkTileJson(body, tileJsonUrl, id, postgis ? { idField: postgis.id_field } : 'archive');
            continue;
          }
          const collection = JSON.parse(body) as { id?: string; links?: { rel: string; href: string }[] };
          const [relation, suffix] = protocol === 'maps' ? [mapRelation, 'map?f=png'] :
            protocol === 'tiles' ? [tilesRelation, 'tiles?f=json'] :
            dggs ? [dggsRelation, 'dggs'] : ['items', 'items?f=json'];
          if (collection.id !== id || !collection.links?.some(({ rel, href }) =>
            rel === relation && href === `${url}/${suffix}`)) {
            throw new Error('Unexpected collection or canonical URL.');
          }
        }
      }
      for (const [root, route] of providerRoutes(config)) {
        if (!hasProtocolMetadata(route)) continue;
        const { protocol } = route;
        const visible = publicationEntries(config).filter(([, publication]) =>
          publication.access === 'public' && publicationRoot(config, publication) === root);
        const api = checkOpenApi(await internal(`${root}/openapi?f=json`, 200), new URL(root, origin).href, visible,
          protocol === 'dggs' ? '3.1.' : '3.0.');
        if (config.providers) {
          // Catalog entries include a bounded live source check.
          const catalog = JSON.parse(await internal(`${root}/${protocol === 'mvt' ? 'catalog' : 'collections'}?f=json`, 200, undefined, '8')) as {
            collections?: { id: string }[]; tiles?: Record<string, unknown>;
          };
          const visibleIds = new Set(catalog.collections?.map(({ id }) => id) ?? Object.keys(catalog.tiles ?? {}));
          for (const publication of collections) {
            const { id, access, protocol } = publication;
            if (publicationRoot(config, publication) === root &&
                (visibleIds.has(id) !== (access === 'public') ||
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
