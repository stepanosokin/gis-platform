import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { Ajv } from 'ajv';
import { parseDocument, stringify } from 'yaml';
import schema from './platform.schema.json' with { type: 'json' };
import type { AdminPermission } from './admin-command.js';

export interface Publication {
  source: string;
  provider: string;
  protocol: 'features';
  access: 'public' | 'registered' | 'private';
  title: string;
  description: string;
  extent: [number, number, number, number];
  time_field?: string;
  freshness?: { max_delay_seconds: number };
}

interface PygeoapiProvider {
  type: 'pygeoapi';
  postgis?: { host: string; port?: number; database: string; user: string; password_file: string };
}

export interface ManagedProvider extends PygeoapiProvider {
  image: string;
  digest?: string;
  api: {
    protocol: 'features';
    scheme: 'http';
    port: number;
    base_path: string;
    public_root: string;
    links: 'canonical';
    readiness: string;
  };
  environment?: Record<string, string>;
  volumes?: Record<string, string>;
}

export type Provider = (PygeoapiProvider & { image?: undefined }) | ManagedProvider;

export interface PostgisSource {
  type: 'postgis';
  schema: string;
  relation: string;
  id_field: string;
  geometry_field: string;
  max_lag_seconds: number;
}

type Source = { type: 'geojson'; path: string } | PostgisSource;

interface PlatformConfig {
  schema_version: 1;
  server: { host: string; port: number; tls?: TlsConfig };
  sources: Record<string, Source>;
  providers: Record<string, Provider>;
  publications: Record<string, Publication>;
  auth?: AuthConfig;
}

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
  sourcePath: string;
  geojsonSourceId?: string;
  postgisSources?: Record<string, PostgisSource>;
  providers?: Record<string, Provider>;
  auth?: AuthConfig;
  tls?: TlsConfig;
} & (
  { publicationId: string; publication: Publication; additionalPublications?: Record<string, Publication> } |
  { publicationId: null; sourceId: string; providerId: string }
);

export function publicationEntries(config: FeaturesConfig): [string, Publication][] {
  if (config.publicationId === null) return [];
  return [[config.publicationId, config.publication], ...Object.entries(config.additionalPublications ?? {})];
}

export function postgisSource(config: FeaturesConfig, id: string) {
  return config.postgisSources && Object.hasOwn(config.postgisSources, id) ? config.postgisSources[id] : undefined;
}

export function hasGeoJson(config: FeaturesConfig, provider?: string) {
  return publicationEntries(config).some(([, publication]) =>
    (provider === undefined || publication.provider === provider) && !postgisSource(config, publication.source));
}

export function needsPublicMetadata(config: FeaturesConfig) {
  return config.providers !== undefined &&
    (!config.auth || publicationEntries(config).every(([, publication]) => publication.access === 'public'));
}

export function builtInProviderId(config: FeaturesConfig) {
  return config.providers ? Object.keys(config.providers).find((id) => !config.providers?.[id]?.image)
    : config.publicationId === null ? config.providerId : config.publication.provider;
}

export function providerRoot(config: FeaturesConfig, id: string) {
  return config.providers?.[id]?.image ? config.providers[id].api.public_root : '/features';
}

export function publicationUrl(config: FeaturesConfig, id: string, publication: Publication) {
  return new URL(`${providerRoot(config, publication.provider)}/collections/${id}`, config.publicUrl).href;
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

export function serializeFeaturesConfig(config: FeaturesConfig) {
  const geojsonSourceId = config.geojsonSourceId ??
    (config.publicationId === null ? config.sourceId : config.publication.source);
  const snapshot: PlatformConfig = {
    schema_version: 1,
    server: { host: new URL(config.publicUrl).hostname, port: config.port, tls: config.tls },
    sources: {
      ...(config.sourcePath && { [geojsonSourceId]: { type: 'geojson', path: config.sourcePath } }),
      ...config.postgisSources,
    },
    providers: config.providers ?? { [builtInProviderId(config)!]: { type: 'pygeoapi' } },
    publications: Object.fromEntries(publicationEntries(config)),
    auth: config.auth,
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
    const errors = (validate.errors ?? []).map(({ instancePath, message, params }) => {
      const field = params.additionalProperty ?? params.missingProperty;
      return `${instancePath || '/'} ${message}${field ? ` (${field})` : ''}`;
    });
    throw new Error(errors.join('; '));
  }

  const providers = Object.entries(config.providers);
  const sources = Object.entries(config.sources);
  const geojsonSources = sources.filter((entry): entry is [string, Extract<Source, { type: 'geojson' }>] =>
    entry[1].type === 'geojson');
  if (geojsonSources.length > 1) throw new Error('Only one GeoJSON source can be configured.');
  const postgisSources = sources.filter((entry): entry is [string, PostgisSource] => entry[1].type === 'postgis');
  if (providers.filter(([, provider]) => !provider.image).length > 1) {
    throw new Error('Only one provider can use the built-in image. Configure an image and API for each additional instance.');
  }
  const roots = new Set<string>();
  for (const [id, provider] of providers) {
    if (provider.postgis) {
      provider.postgis.password_file = resolve(directory, provider.postgis.password_file);
      provider.postgis.port ??= 5432;
    }
    if (!provider.image && !Object.hasOwn(provider, 'image')) {
      roots.add('/features');
      continue;
    }
    if (!provider.image || id.length > 54) throw new Error(`Invalid managed provider '${id}'.`);
    const { digest } = imageReference(provider.image);
    if (digest && provider.digest && digest !== provider.digest) throw new Error(`Provider '${id}' has conflicting digests.`);
    const { public_root: root } = provider.api;
    if (['/account', '/api', '/internal'].some((reserved) => root === reserved || root.startsWith(reserved + '/'))) {
      throw new Error(`Provider '${id}' uses a reserved public root.`);
    }
    roots.add(root);
    const targets = Object.values(provider.volumes ?? {});
    const reservedPaths = ['/source', '/etc/pygeoapi/gis', '/venv'];
    if (provider.postgis) reservedPaths.push('/run/secrets/postgis_password');
    if (targets.some((target) => target.split('/').some((segment) => segment === '.' || segment === '..') ||
        reservedPaths.some((path) =>
          target === path || target.startsWith(path + '/') || path.startsWith(target + '/'))) ||
        new Set(targets).size !== targets.length) throw new Error(`Invalid volume targets for provider '${id}'.`);
    if (Object.keys(provider.environment ?? {}).some((name) =>
      ['PYGEOAPI_CONFIG', 'PYGEOAPI_OPENAPI', 'SCRIPT_NAME'].includes(name) ||
      (provider.postgis && ['PGPASSWORD', 'PGPASSFILE'].includes(name)))) {
      throw new Error(`Provider '${id}' overrides a required adapter environment variable.`);
    }
  }
  for (const root of roots) {
    if ([...roots].some((other) => other !== root && root.startsWith(other + '/'))) {
      throw new Error(`Ambiguous public root '${root}'.`);
    }
  }

  const entries = Object.entries(config.publications).map((
    [id, { source, provider, protocol, access, title, description, extent, time_field, freshness }],
  ): [string, Publication] => [id, {
    source, provider, protocol, access, title, description, extent,
    ...(time_field !== undefined && { time_field }), ...(freshness && { freshness }),
  }]);
  const sourceTypes = new Map<string, Source['type']>();
  for (const [id, publication] of entries) {
    const { source, provider, protocol, access, extent, time_field, freshness } = publication;
    if (!Object.hasOwn(config.sources, source)) {
      throw new Error(`Publication '${id}' references unknown source '${source}'.`);
    }
    if (!Object.hasOwn(config.providers, provider)) {
      throw new Error(`Publication '${id}' references unknown provider '${provider}'.`);
    }
    const instance = config.providers[provider];
    if (instance?.image && instance.api.protocol !== protocol) {
      throw new Error(`Publication '${id}' uses a protocol unsupported by provider '${provider}'.`);
    }
    const sourceConfig = config.sources[source]!;
    const suppliedType = sourceTypes.get(provider);
    if (suppliedType && suppliedType !== sourceConfig.type) {
      throw new Error(`Provider '${provider}' serves GeoJSON and PostGIS. Use separate provider instances.`);
    }
    sourceTypes.set(provider, sourceConfig.type);
    if (sourceConfig.type === 'postgis') {
      if (!instance?.postgis) throw new Error(`Publication '${id}' requires a PostGIS connection on provider '${provider}'.`);
      const max_delay_seconds = freshness?.max_delay_seconds ?? 60;
      if (sourceConfig.max_lag_seconds > max_delay_seconds) {
        throw new Error(`Publication '${id}': source max_lag_seconds exceeds freshness.max_delay_seconds.`);
      }
      publication.freshness = { max_delay_seconds };
    } else if (freshness || time_field) {
      throw new Error(`Publication '${id}' requires a PostGIS source for freshness or time_field.`);
    }
    const [west, south, east, north] = extent;
    if (west > east || south > north) throw new Error(`Publication '${id}' has an invalid extent.`);
    if (access !== 'public' && !config.auth) throw new Error(`Publication '${id}' requires auth configuration.`);
  }
  const [first, ...others] = entries;
  const geojson = geojsonSources[0];
  const sourceId = geojson?.[0] ?? sources[0]![0];
  const providerId = providers[0]?.[0] ?? '';

  const { host, port, tls } = config.server;
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
  return {
    port,
    publicUrl: new URL('/features', `${tls ? 'https' : 'http'}://${host}:${port}`).href,
    sourcePath: geojson ? resolve(directory, geojson[1].path) : '',
    ...(postgisSources.length && { postgisSources: Object.fromEntries(postgisSources) }),
    ...(postgisSources.length && geojson && { geojsonSourceId: geojson[0] }),
    ...(postgisSources.length || providers.length !== 1 || providers.some(([, provider]) => provider.image || provider.postgis)
      ? { providers: config.providers } : {}),
    ...(first ? { publicationId: first[0], publication: first[1],
      ...(others.length > 0 && { additionalPublications: Object.fromEntries(others) }) }
      : { publicationId: null, sourceId, providerId }),
    ...(auth && { auth }),
    ...(tls && { tls: { cert_file: resolve(directory, tls.cert_file), key_file: resolve(directory, tls.key_file) } }),
  };
}
