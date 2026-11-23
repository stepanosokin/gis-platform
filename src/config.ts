import { readFile } from 'node:fs/promises';
import { dirname, extname, resolve } from 'node:path';
import { Ajv } from 'ajv';
import { parseDocument, stringify } from 'yaml';
import schema from './platform.schema.json' with { type: 'json' };
import type { AdminPermission } from './admin-command.js';

export interface Publication {
  source: string;
  provider: string;
  protocol: 'features' | 'maps' | 'mvt' | 'tiles' | 'dggs';
  tile_provider?: string;
  access: 'public' | 'registered' | 'private';
  title: string;
  description: string;
  extent: [number, number, number, number];
  time_field?: string;
  mvt_properties?: string[];
  maplibre?: { style_file: string; resources?: Record<string, string> };
  crs?: string[];
  freshness?: { max_delay_seconds: number };
}

export interface PostgisConnection {
  host: string;
  port?: number;
  database: string;
  user: string;
  password_file: string;
}

export interface ManagedProvider {
  type: 'pygeoapi' | 'martin' | 'pydggsapi';
  image: string;
  digest?: string;
  api: {
    scheme: 'http';
    port: number;
    base_path: string;
    links: 'canonical';
    readiness: string;
  } & (
    { protocol: Publication['protocol']; public_root: string; protocols?: never; public_prefix?: never } |
    { protocols: Publication['protocol'][]; public_prefix?: string; protocol?: never; public_root?: never }
  );
  environment?: Record<string, string>;
  volumes?: Record<string, string>;
}

export type Provider = { type: 'pygeoapi'; image?: undefined } | ManagedProvider;

export interface PostgisSource {
  type: 'postgis';
  connection: string;
  schema: string;
  relation: string;
  id_field: string;
  geometry_field: string;
  max_lag_seconds: number;
}

export type VectorFileSource =
  ({ type: 'geopackage' | 'shapefile'; layer: string } | { type: 'geoparquet'; layer?: never }) &
  { path: string; id_field: string };
export type RasterFileSource = { type: 'geotiff' | 'cog'; path: string; epsg?: number };
export type TileArchiveSource = { type: 'mbtiles' | 'pmtiles'; path: string };
export type DggsSource = { type: 'parquet'; path: string; id_field: string; resolution: number; properties: string[] };
export type FileSource = VectorFileSource | RasterFileSource | TileArchiveSource | DggsSource;
type Source = { type: 'geojson'; path: string } | FileSource | PostgisSource;

interface PlatformConfig {
  schema_version: 1;
  server: { host: string; port?: number; public_url?: string; tls?: Partial<TlsConfig> };
  postgis_connections?: Record<string, PostgisConnection>;
  sources: Record<string, Source>;
  providers: Record<string, Provider>;
  publications: Record<string, Publication>;
  auth?: AuthConfig;
  cors?: CorsConfig;
}

interface CorsConfig { allowed_origins: string[] }

interface SmtpConfig {
  host: string;
  port: number;
  from: string;
  secure?: boolean;
  username?: string;
  password_file?: string;
}

interface TlsConfig {
  cert_file: string;
  key_file: string;
  ca_file?: string;
}

export interface AdminConfig extends TlsConfig {
  port: number;
  ca_file: string;
  operators: Record<string, AdminPermission[]>;
}

export type AuthConfig = {
  secret_file: string;
  postgres_password_file: string;
  administrator_emails?: string[];
  cli?: AdminConfig;
} & ({ mode: 'development'; mailpit_port?: number } | { mode: 'production'; smtp: SmtpConfig });

export type FeaturesConfig = {
  port: number;
  publicUrl: string;
  publicOrigin?: string;
  sourcePath: string;
  geojsonSourceId?: string;
  vectorFiles?: Record<string, VectorFileSource>;
  rasterFiles?: Record<string, RasterFileSource>;
  tileArchives?: Record<string, TileArchiveSource>;
  dggsSources?: Record<string, DggsSource>;
  postgisConnections?: Record<string, PostgisConnection>;
  postgisSources?: Record<string, PostgisSource>;
  providers?: Record<string, Provider>;
  providerServiceNames?: Record<string, string>;
  auth?: AuthConfig;
  tls?: TlsConfig;
  cors?: CorsConfig;
} & (
  { publicationId: string; publication: Publication; additionalPublications?: Record<string, Publication> } |
  { publicationId: null; sourceId: string; providerId: string }
);

export function publicationEntries(config: FeaturesConfig): [string, Publication][] {
  if (config.publicationId === null) return [];
  return [[config.publicationId, config.publication], ...Object.entries(config.additionalPublications ?? {})];
}

export function publicationsForProvider(config: FeaturesConfig, id: string) {
  return publicationEntries(config).filter(([, publication]) =>
    publication.provider === id || publication.tile_provider === id);
}

export function postgisSource(config: FeaturesConfig, id: string) {
  return config.postgisSources && Object.hasOwn(config.postgisSources, id) ? config.postgisSources[id] : undefined;
}

export function postgisConnectionsForProvider(config: FeaturesConfig, provider: string) {
  const ids = new Set<string>();
  for (const [, publication] of publicationEntries(config)) {
    if ((publication.tile_provider ?? publication.provider) !== provider) continue;
    const connection = postgisSource(config, publication.source)?.connection;
    if (connection) ids.add(connection);
  }
  return [...ids].sort().map((id) => [id, config.postgisConnections![id]!] as const);
}

export function postgisSecretName(connection: string) {
  return `postgis-${connection}`;
}

export function hasGeoJson(config: FeaturesConfig, provider?: string) {
  return publicationEntries(config).some(([, publication]) =>
    (provider === undefined || publication.provider === provider) &&
    !postgisSource(config, publication.source) && !fileSource(config, publication.source));
}

export function vectorFile(config: FeaturesConfig, id: string) {
  return config.vectorFiles && Object.hasOwn(config.vectorFiles, id) ? config.vectorFiles[id] : undefined;
}

export function rasterFile(config: FeaturesConfig, id: string) {
  return config.rasterFiles && Object.hasOwn(config.rasterFiles, id) ? config.rasterFiles[id] : undefined;
}

export function tileArchive(config: FeaturesConfig, id: string) {
  return config.tileArchives && Object.hasOwn(config.tileArchives, id) ? config.tileArchives[id] : undefined;
}

export function fileSource(config: FeaturesConfig, id: string) {
  return vectorFile(config, id) ?? rasterFile(config, id) ?? tileArchive(config, id) ??
    (config.dggsSources && Object.hasOwn(config.dggsSources, id) ? config.dggsSources[id] : undefined);
}

export const crs84 = 'http://www.opengis.net/def/crs/OGC/1.3/CRS84';

function supportedCrs(id: string, source: Source, values: string[]) {
  const result = new Set([crs84]);
  for (const value of values) {
    if (value === 'CRS84' || value === crs84) continue;
    const match = /^(?:((?:EPSG|ESRI)):(\d{1,8})|http:\/\/www\.opengis\.net\/def\/crs\/(EPSG|ESRI)\/0\/(\d{1,8}))$/.exec(value);
    if (!match) throw new Error(`Publication '${id}' has invalid CRS '${value}'. Use CRS84, EPSG:<code> or ESRI:<code>.`);
    const authority = match[1] ?? match[3];
    const code = match[2] ?? match[4];
    if (authority === 'EPSG' && code === '102026') {
      throw new Error(`Publication '${id}': use ESRI:102026 for Asia North Equidistant Conic.`);
    }
    if ((source.type === 'geojson' || source.type === 'postgis') &&
      (authority !== 'EPSG' || (code !== '4326' && code !== '3857'))) {
      throw new Error(`Publication '${id}': ${value} is unsupported for ${source.type} bbox. Use CRS84, EPSG:4326 or EPSG:3857.`);
    }
    result.add(`http://www.opengis.net/def/crs/${authority}/0/${code}`);
  }
  return [...result];
}

export function usedFileSources(config: FeaturesConfig, provider?: string) {
  return [...new Set(publicationEntries(config)
    .filter(([, publication]) => provider === undefined || publication.provider === provider)
    .map(([, publication]) => publication.source))]
    .flatMap((id): [string, FileSource][] => {
      const source = fileSource(config, id);
      return source ? [[id, source]] : [];
    });
}

export function needsMetadataService(config: FeaturesConfig) {
  return config.providers !== undefined &&
    (Object.keys(config.providers).length === 0 || Object.values(config.providers).some((provider) =>
      provider.type !== 'martin' || provider.api.protocols)) &&
    (!config.auth || publicationEntries(config).some(([, publication]) => publication.protocol === 'maps') ||
      publicationEntries(config).every(([, publication]) => publication.access === 'public'));
}

export function builtInProviderId(config: FeaturesConfig) {
  return config.providers ? Object.keys(config.providers).find((id) => !config.providers?.[id]?.image)
    : config.publicationId === null ? config.providerId : config.publication.provider;
}

export function configuredProviders(config: FeaturesConfig): Record<string, Provider> {
  const builtIn = builtInProviderId(config);
  return config.providers ?? (builtIn ? { [builtIn]: { type: 'pygeoapi' } } : {});
}

const adapterProtocols: Record<ManagedProvider['type'], Publication['protocol'][]> = {
  pygeoapi: ['features', 'maps', 'tiles'], martin: ['mvt'], pydggsapi: ['dggs'],
};

export function providerProtocols(provider: Provider | undefined): Publication['protocol'][] {
  if (!provider?.image) return ['features'];
  return provider.api.protocols ?? [provider.api.protocol];
}

export function providerServiceName(config: FeaturesConfig, id: string) {
  if (!config.providers?.[id]?.image) return 'pygeoapi';
  const names = config.providerServiceNames;
  return names && Object.hasOwn(names, id) ? names[id]! : `provider-${id}`;
}

export function providerRoot(config: FeaturesConfig, id: string, protocol: Publication['protocol']) {
  const provider = config.providers?.[id];
  if (!provider?.image) return '/features';
  return provider.api.public_root ?? `/${provider.api.public_prefix ?? id}/${protocol}`;
}

export function providerBasePath(config: FeaturesConfig, id: string) {
  const provider = config.providers?.[id];
  if (!provider?.image) return '';
  return provider.type === 'pydggsapi' ? providerRoot(config, id, 'dggs') :
    provider.api.base_path === '/' ? '' : provider.api.base_path;
}

export function publicationRoot(config: FeaturesConfig, publication: Publication) {
  return providerRoot(config, publication.provider, publication.protocol);
}

export function providerRoutes(config: FeaturesConfig) {
  const routes = new Map<string, { protocol: Publication['protocol']; ids: string[]; nested: boolean }>();
  for (const [id, provider] of Object.entries(config.providers ?? {})) {
    for (const protocol of providerProtocols(provider)) {
      const root = providerRoot(config, id, protocol);
      const route = routes.get(root);
      if (route) route.ids.push(id);
      else routes.set(root, { protocol, ids: [id], nested: Boolean(provider.image && provider.api.protocols) });
    }
  }
  if (!routes.size) routes.set('/features', { protocol: 'features', ids: [], nested: false });
  return routes;
}

export function providerRouteOwner(route: { protocol: Publication['protocol']; ids: string[] }, firstPublication?: Publication) {
  return route.protocol === 'tiles' ? firstPublication?.provider ?? route.ids[0] : route.ids[0];
}

export function hasProtocolMetadata({ protocol, nested }: { protocol: Publication['protocol']; nested: boolean }) {
  return protocol !== 'mvt' || nested;
}

export function managedProviderRuns(config: FeaturesConfig, id: string) {
  const provider = config.providers?.[id];
  return Boolean(provider?.image && (provider.type !== 'martin' ||
    publicationsForProvider(config, id).length));
}

export function publicationUrl(config: FeaturesConfig, id: string, publication: Publication) {
  const root = publicationRoot(config, publication);
  return new URL(`${root}${publication.protocol === 'mvt' ? '' : '/collections'}/${id}`, config.publicUrl).href;
}

export function imageReference(image: string) {
  const match = /^((?:(?:[a-z0-9][a-z0-9.-]*)(?::[0-9]+)?\/)?[a-z0-9]+(?:[._-]+[a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-]+[a-z0-9]+)*)*)(?::([\w][\w.-]{0,127}))?(?:@(sha256:[0-9a-f]{64}))?$/.exec(image);
  if (!match?.[1] || (!match[2] && !match[3]) || match[2] === 'latest') {
    throw new Error('A provider image must include a version tag or an immutable digest.');
  }
  return { repository: match[1], digest: match[3] };
}

export function pinnedImage(provider: ManagedProvider) {
  const { repository, digest } = imageReference(provider.image);
  if (digest) return provider.image;
  if (!provider.digest) throw new Error('The provider image has not been pinned.');
  return `${repository}@${provider.digest}`;
}

const pydggsapiRepository = 'ghcr.io/landscapegeoinformatics/pydggsapi';
const pydggsapiDigest = 'sha256:2c2b1683a474243639d59849679e32a434ab5581a7e54ce02879213bf509ea63';
export const dggsRoot = '/dggs';

export function serializeFeaturesConfig(config: FeaturesConfig) {
  const geojsonSourceId = config.geojsonSourceId ??
    (config.publicationId === null ? config.sourceId : config.publication.source);
  const snapshot: PlatformConfig = {
    schema_version: 1,
    server: { host: new URL(config.publicUrl).hostname, port: config.port, public_url: config.publicOrigin, tls: config.tls },
    postgis_connections: config.postgisConnections,
    sources: {
      ...(config.sourcePath && { [geojsonSourceId]: { type: 'geojson', path: config.sourcePath } }),
      ...config.postgisSources,
      ...config.vectorFiles,
      ...config.rasterFiles,
      ...config.tileArchives,
      ...config.dggsSources,
    },
    providers: config.providers ?? { [builtInProviderId(config)!]: { type: 'pygeoapi' } },
    publications: Object.fromEntries(publicationEntries(config)),
    auth: config.auth,
    cors: config.cors,
  };
  return stringify(snapshot);
}

const validate = new Ajv({ allErrors: true, ownProperties: true }).compile<PlatformConfig>(schema);

export async function readFeaturesConfig(filename: string) {
  const yaml = await readFile(filename, 'utf8');
  return { config: parseFeaturesConfig(yaml, dirname(filename)), yaml };
}

export function parseFeaturesConfig(yaml: string, directory: string): FeaturesConfig {
  const document = parseDocument(yaml);
  if (document.errors.length) throw new Error('The configuration is not valid YAML.');

  const config: unknown = document.toJS();
  if (!validate(config)) {
    const legacy = validate.errors?.find(({ instancePath, params }) =>
      /^\/providers\/[^/]+$/.test(instancePath) && params.additionalProperty === 'postgis');
    if (legacy) {
      const id = legacy.instancePath.split('/').at(-1);
      throw new Error(`Replace providers.${id}.postgis with postgis_connections and sources.<id>.connection.`);
    }
    const errors = (validate.errors ?? []).map(({ instancePath, message, params }) => {
      const field = params.additionalProperty ?? params.missingProperty;
      return `${instancePath || '/'} ${message}${field ? ` (${field})` : ''}`;
    });
    throw new Error(errors.join('; '));
  }

  const providers = Object.entries(config.providers);
  const cors = config.cors;
  if (cors?.allowed_origins.some((origin) => URL.parse(origin)?.origin !== origin)) {
    throw new Error('CORS origins must be canonical HTTP(S) origins without a path.');
  }
  const sources = Object.entries(config.sources);
  const geojsonSources = sources.filter((entry): entry is [string, Extract<Source, { type: 'geojson' }>] =>
    entry[1].type === 'geojson');
  if (geojsonSources.length > 1) throw new Error('Only one GeoJSON source can be configured.');
  const postgisSources = sources.filter((entry): entry is [string, PostgisSource] => entry[1].type === 'postgis');
  const postgisConnections = config.postgis_connections ?? {};
  for (const connection of Object.values(postgisConnections)) {
    connection.password_file = resolve(directory, connection.password_file);
    connection.port ??= 5432;
  }
  for (const [id, source] of postgisSources) {
    if (!Object.hasOwn(postgisConnections, source.connection)) {
      throw new Error(`Source '${id}' references an unknown PostGIS connection '${source.connection}'.`);
    }
  }
  const vectorFiles = sources.filter((entry): entry is [string, VectorFileSource] =>
    entry[1].type === 'geopackage' || entry[1].type === 'shapefile' || entry[1].type === 'geoparquet');
  const fileExtensions = { geopackage: '.gpkg', shapefile: '.shp', geoparquet: '.parquet' };
  for (const [id, source] of vectorFiles) {
    const extension = fileExtensions[source.type];
    if (extname(source.path) !== extension) throw new Error(`Source '${id}' requires a ${extension} file.`);
    source.path = resolve(directory, source.path);
  }
  const rasterFiles = sources.filter((entry): entry is [string, RasterFileSource] =>
    entry[1].type === 'geotiff' || entry[1].type === 'cog');
  for (const [id, source] of rasterFiles) {
    if (!/\.tiff?$/i.test(source.path)) throw new Error(`Source '${id}' requires a .tif or .tiff file.`);
    source.path = resolve(directory, source.path);
    source.epsg ??= 4326;
  }
  const tileArchives = sources.filter((entry): entry is [string, TileArchiveSource] =>
    entry[1].type === 'mbtiles' || entry[1].type === 'pmtiles');
  for (const [id, source] of tileArchives) {
    const extension = `.${source.type}`;
    if (extname(source.path).toLowerCase() !== extension) throw new Error(`Source '${id}' requires a ${extension} file.`);
    source.path = resolve(directory, source.path);
  }
  const dggsSources = sources.filter((entry): entry is [string, DggsSource] => entry[1].type === 'parquet');
  for (const [id, source] of dggsSources) {
    if (extname(source.path).toLowerCase() !== '.parquet' || source.properties.includes(source.id_field)) {
      throw new Error(`Source '${id}' requires a .parquet snapshot and properties distinct from the H3 ID field.`);
    }
    source.path = resolve(directory, source.path);
  }
  if (providers.filter(([, provider]) => !provider.image).length > 1) {
    throw new Error('Only one provider can use the built-in image. Configure an image and API for each additional instance.');
  }
  const roots = new Map<string, Publication['protocol']>();
  const prefixes = new Set<string>();
  const reservedRoots = ['/account', '/api', '/internal'];
  const postgisReaders = new Map<string, Set<string>>();
  for (const publication of Object.values(config.publications)) {
    const source = config.sources[publication.source];
    if (source?.type !== 'postgis') continue;
    const reader = publication.tile_provider ?? publication.provider;
    if (!postgisReaders.has(reader)) postgisReaders.set(reader, new Set());
    postgisReaders.get(reader)!.add(source.connection);
  }
  for (const [id, provider] of providers) {
    if (provider.type === 'martin' && !provider.image) {
      throw new Error(`Martin provider '${id}' requires an image and API.`);
    }
    if (provider.type === 'pydggsapi' && !provider.image) {
      throw new Error(`pydggsapi provider '${id}' requires an image and API.`);
    }
    if (!provider.image && !Object.hasOwn(provider, 'image')) {
      roots.set('/features', 'features');
      continue;
    }
    if (!provider.image || id.length > 54) throw new Error(`Invalid managed provider '${id}'.`);
    const { repository, digest } = imageReference(provider.image);
    if (digest && provider.digest && digest !== provider.digest) throw new Error(`Provider '${id}' has conflicting digests.`);
    const { public_root: root, protocols, public_prefix: prefix = id, base_path: base, readiness } = provider.api;
    if (providerProtocols(provider).some((protocol) => !adapterProtocols[provider.type].includes(protocol))) {
      throw new Error(`Provider '${id}' uses a protocol unsupported by its ${provider.type} adapter.`);
    }
    if (protocols) {
      const path = `/${prefix}`;
      if (prefixes.has(path)) throw new Error(`Duplicate public prefix '${path}'.`);
      if ([...reservedRoots, '/features', '/maps', '/tiles', '/mvt', dggsRoot].includes(path)) {
        throw new Error(`Provider '${id}' uses a reserved public prefix '${path}'.`);
      }
      prefixes.add(path);
    }
    if (provider.type === 'martin') {
      if ((root && root !== '/mvt') || readiness !== '/health' ||
          provider.environment || provider.volumes) {
        throw new Error(`Martin provider '${id}' requires readiness /health and legacy public_root /mvt.`);
      }
    } else if (root === '/mvt') {
      throw new Error(`Provider '${id}': /mvt and protocol mvt require Martin.`);
    }
    if (provider.api.protocol === 'maps' && root !== '/maps') {
      throw new Error(`Maps provider '${id}' requires public_root /maps and file sources.`);
    }
    if (provider.api.protocol === 'tiles' && root !== '/tiles') {
      throw new Error(`Tiles provider '${id}' requires public_root /tiles and a separate Martin instance for PostGIS.`);
    }
    if (provider.type === 'pydggsapi') {
      if ((root ? root !== dggsRoot || base !== root : base !== '/') || readiness !== '/conformance' ||
          provider.environment || provider.volumes) {
        throw new Error(`pydggsapi provider '${id}' requires readiness /conformance and base_path / for nested URLs, or base_path and public_root /dggs.`);
      }
      if (repository !== pydggsapiRepository || (digest ?? provider.digest ?? pydggsapiDigest) !== pydggsapiDigest ||
          (provider.image !== `${repository}:0.4.0` && provider.image !== `${repository}@${pydggsapiDigest}`)) {
        throw new Error(`Provider '${id}' requires the accepted pydggsapi 0.4.0 image.`);
      }
      provider.digest ??= pydggsapiDigest;
    }
    if (root) {
      if (reservedRoots.some((reserved) => root === reserved || root.startsWith(reserved + '/'))) {
        throw new Error(`Provider '${id}' uses a reserved public root.`);
      }
      const protocol = provider.api.protocol!;
      const existing = roots.get(root);
      if (existing && existing !== protocol) throw new Error(`Providers at '${root}' must use the same protocol.`);
      roots.set(root, protocol);
    }
    const targets = Object.values(provider.volumes ?? {});
    const reservedPaths = ['/source', '/etc/pygeoapi/gis', '/venv'];
    const connections = postgisReaders.get(id);
    if (connections) {
      for (const connection of connections) reservedPaths.push(`/run/secrets/${postgisSecretName(connection)}`);
    }
    if (targets.some((target) => target.split('/').some((segment) => segment === '.' || segment === '..') ||
        reservedPaths.some((path) =>
          target === path || target.startsWith(path + '/') || path.startsWith(target + '/'))) ||
        new Set(targets).size !== targets.length) throw new Error(`Invalid volume targets for provider '${id}'.`);
    if (Object.keys(provider.environment ?? {}).some((name) =>
      ['PYGEOAPI_CONFIG', 'PYGEOAPI_OPENAPI', 'GIS_PYGEOAPI_PROTOCOLS', 'SCRIPT_NAME'].includes(name) ||
      (connections && ['PGPASSWORD', 'PGPASSFILE'].includes(name)))) {
      throw new Error(`Provider '${id}' overrides a required adapter environment variable.`);
    }
  }
  const paths = [...roots.keys()];
  for (const root of paths) {
    if (paths.some((other) => other !== root && root.startsWith(other + '/'))) {
      throw new Error(`Ambiguous public root '${root}'.`);
    }
    if ([...prefixes].some((prefix) => root === prefix || root.startsWith(prefix + '/'))) {
      throw new Error(`Public root '${root}' overlaps an instance prefix.`);
    }
  }

  const entries = Object.entries(config.publications).map((
    [id, { source, provider, protocol, access, title, description, extent, time_field, freshness, crs, mvt_properties, tile_provider, maplibre }],
  ): [string, Publication] => [id, {
    source, provider, protocol, access, title, description, extent,
    ...(time_field !== undefined && { time_field }), ...(freshness && { freshness }), ...(crs && { crs }),
    ...(mvt_properties && { mvt_properties }), ...(tile_provider && { tile_provider }),
    ...(maplibre && { maplibre: {
      style_file: resolve(directory, maplibre.style_file),
      ...(maplibre.resources && { resources: Object.fromEntries(Object.entries(maplibre.resources)
        .map(([path, file]) => [path, resolve(directory, file)])) }),
    } }),
  }]);
  for (const [id, publication] of entries) {
    const { source, provider, protocol, access, extent, time_field, freshness } = publication;
    if (publication.maplibre && protocol !== 'mvt') {
      throw new Error(`Publication '${id}': maplibre is only supported for direct web tiles.`);
    }
    if (!Object.hasOwn(config.sources, source)) {
      throw new Error(`Publication '${id}' references unknown source '${source}'.`);
    }
    if (!Object.hasOwn(config.providers, provider)) {
      throw new Error(`Publication '${id}' references unknown provider '${provider}'.`);
    }
    const instance: Provider | undefined = config.providers[provider];
    if (!providerProtocols(instance).includes(protocol)) {
      throw new Error(`Publication '${id}' uses a protocol unsupported by provider '${provider}'.`);
    }
    const sourceConfig = config.sources[source]!;
    if ((protocol === 'dggs') !== (sourceConfig.type === 'parquet') ||
        (protocol === 'dggs' && (publication.crs || time_field || freshness))) {
      throw new Error(`Publication '${id}': DGGS requires a Parquet H3 snapshot without CRS, time or freshness overrides.`);
    }
    const archive = sourceConfig.type === 'mbtiles' || sourceConfig.type === 'pmtiles';
    const renderer: string | undefined = protocol === 'tiles' ? publication.tile_provider : provider;
    if (protocol === 'tiles') {
      const martin = renderer && Object.hasOwn(config.providers, renderer) ? config.providers[renderer] : undefined;
      if (sourceConfig.type !== 'postgis' || martin?.type !== 'martin') {
        throw new Error(`Publication '${id}': Tiles requires a PostGIS source and tile_provider referencing a Martin instance.`);
      }
    } else if (publication.tile_provider) {
      throw new Error(`Publication '${id}': tile_provider is only supported for Tiles.`);
    }
    if (protocol === 'mvt' || protocol === 'tiles') {
      if ((!archive && sourceConfig.type !== 'postgis') || publication.crs || time_field) {
        throw new Error(`Publication '${id}': Martin requires PostGIS, MBTiles or PMTiles and uses Web Mercator without CRS or time overrides.`);
      }
      if (archive && publication.mvt_properties) {
        throw new Error(`Publication '${id}': mvt_properties requires a PostGIS source.`);
      }
      if (['catalog', 'config', 'font', 'health', 'help', 'index', 'manifest', 'metrics', 'refresh',
        'reload', 'sprite', 'status'].includes(id) ||
        (protocol === 'mvt' && instance?.image && instance.api.protocols && ['openapi', 'conformance'].includes(id))) {
        throw new Error(`Publication '${id}': this ID is reserved by Martin.`);
      }
    } else if (publication.mvt_properties) {
      throw new Error(`Publication '${id}': mvt_properties is only supported for MVT.`);
    }
    const raster = sourceConfig.type === 'geotiff' || sourceConfig.type === 'cog';
    if (raster !== (protocol === 'maps') || (archive && protocol !== 'mvt')) {
      throw new Error(`Publication '${id}' has a source type unsupported by protocol '${protocol}'.`);
    }
    if (raster && publication.crs) throw new Error(`Publication '${id}': set the raster source epsg instead of crs.`);
    if (publication.crs) publication.crs = supportedCrs(id, sourceConfig, publication.crs);
    if (sourceConfig.type === 'postgis') {
      const max_delay_seconds = freshness?.max_delay_seconds ?? 60;
      if (sourceConfig.max_lag_seconds > max_delay_seconds) {
        throw new Error(`Publication '${id}': source max_lag_seconds exceeds freshness.max_delay_seconds.`);
      }
      publication.freshness = { max_delay_seconds };
    } else if (freshness || (time_field && sourceConfig.type !== 'geoparquet')) {
      throw new Error(`Publication '${id}' requires a PostGIS source for freshness or time_field.`);
    }
    const [west, south, east, north] = extent;
    if (west > east || south > north || (raster && (west === east || south === north))) {
      throw new Error(`Publication '${id}' has an invalid extent.`);
    }
    if (access !== 'public' && !config.auth) throw new Error(`Publication '${id}' requires auth configuration.`);
  }
  const [first, ...others] = entries;
  const geojson = geojsonSources[0];
  const sourceId = geojson?.[0] ?? sources[0]![0];
  const providerId = providers[0]?.[0] ?? '';

  const { host, tls, public_url, port = tls?.cert_file ? 443 : 80 } = config.server;
  const gatewayAddress = new URL(`${tls?.cert_file ? 'https' : 'http'}://${host}:${port}`);
  const publicAddress = public_url === undefined ? undefined : URL.parse(public_url);
  if (public_url !== undefined &&
      (!publicAddress || publicAddress.port === '0' || publicAddress.hostname !== gatewayAddress.hostname)) {
    throw new Error('server.public_url requires the hostname from server.host and a valid TCP port (1–65535).');
  }
  const auth = config.auth;
  if (auth) {
    auth.secret_file = resolve(directory, auth.secret_file);
    auth.postgres_password_file = resolve(directory, auth.postgres_password_file);
    if (auth.cli) {
      if (auth.cli.port === port || (auth.mode === 'development' && auth.cli.port === (auth.mailpit_port ?? 8025))) {
        throw new Error('The admin CLI requires a separate local port.');
      }
      auth.cli.ca_file = resolve(directory, auth.cli.ca_file);
      auth.cli.cert_file = resolve(directory, auth.cli.cert_file);
      auth.cli.key_file = resolve(directory, auth.cli.key_file);
    }
    if (auth.mode === 'production' && auth.smtp.password_file) {
      auth.smtp.password_file = resolve(directory, auth.smtp.password_file);
    }
  }
  const fileSources = postgisSources.length || vectorFiles.length || rasterFiles.length || tileArchives.length || dggsSources.length;
  // Confirmed plans without these names retain their previous Compose service keys.
  const servicePrefix = 'provider-';
  const serviceNames = providers.filter(([id, provider]) => provider.image && id.startsWith(servicePrefix) &&
    !config.providers[id.slice(servicePrefix.length)]?.image);
  return {
    port,
    publicUrl: new URL('/features', publicAddress ?? gatewayAddress).href,
    ...(publicAddress && { publicOrigin: publicAddress.origin }),
    sourcePath: geojson ? resolve(directory, geojson[1].path) : '',
    ...(config.postgis_connections && { postgisConnections }),
    ...(postgisSources.length && { postgisSources: Object.fromEntries(postgisSources) }),
    ...(vectorFiles.length && { vectorFiles: Object.fromEntries(vectorFiles) }),
    ...(rasterFiles.length && { rasterFiles: Object.fromEntries(rasterFiles) }),
    ...(tileArchives.length && { tileArchives: Object.fromEntries(tileArchives) }),
    ...(dggsSources.length && { dggsSources: Object.fromEntries(dggsSources) }),
    ...(fileSources && geojson && { geojsonSourceId: geojson[0] }),
    ...(fileSources || entries.some(([, pub]) => pub.crs) ||
      providers.length !== 1 || providers.some(([, provider]) => provider.image)
      ? { providers: config.providers } : {}),
    ...(serviceNames.length && { providerServiceNames: Object.fromEntries(serviceNames.map(([id]) => [id, id])) }),
    ...(first ? { publicationId: first[0], publication: first[1],
      ...(others.length > 0 && { additionalPublications: Object.fromEntries(others) }) }
      : { publicationId: null, sourceId, providerId }),
    ...(auth && { auth }),
    ...(cors && { cors }),
    ...(tls?.cert_file && { tls: { cert_file: resolve(directory, tls.cert_file), key_file: resolve(directory, tls.key_file!),
      ...(tls.ca_file && { ca_file: resolve(directory, tls.ca_file) }) } }),
  };
}
