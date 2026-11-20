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
}

interface PlatformConfig {
  schema_version: 1;
  server: { host: string; port: number; tls?: TlsConfig };
  sources: Record<string, { type: 'geojson'; path: string }>;
  providers: Record<string, { type: 'pygeoapi' }>;
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

export function serializeFeaturesConfig(config: FeaturesConfig) {
  const snapshot: PlatformConfig = {
    schema_version: 1,
    server: { host: new URL(config.publicUrl).hostname, port: config.port, tls: config.tls },
    sources: { [config.publicationId === null ? config.sourceId : config.publication.source]: { type: 'geojson', path: config.sourcePath } },
    providers: { [config.publicationId === null ? config.providerId : config.publication.provider]: { type: 'pygeoapi' } },
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

  const entries = Object.entries(config.publications).map((
    [id, { source, provider, protocol, access, title, description, extent }],
  ): [string, Publication] => [id, { source, provider, protocol, access, title, description, extent }]);
  for (const [id, { source, provider, access, extent }] of entries) {
    if (!Object.hasOwn(config.sources, source)) {
      throw new Error(`Publication '${id}' references unknown source '${source}'.`);
    }
    if (!Object.hasOwn(config.providers, provider)) {
      throw new Error(`Publication '${id}' references unknown provider '${provider}'.`);
    }
    const [west, south, east, north] = extent;
    if (west > east || south > north) throw new Error(`Publication '${id}' has an invalid extent.`);
    if (access !== 'public' && !config.auth) throw new Error(`Publication '${id}' requires auth configuration.`);
  }
  const [first, ...others] = entries;
  const [sourceId, sourceConfig] = Object.entries(config.sources)[0]!;
  const providerId = Object.keys(config.providers)[0]!;

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
    sourcePath: resolve(directory, sourceConfig.path),
    ...(first ? { publicationId: first[0], publication: first[1],
      ...(others.length > 0 && { additionalPublications: Object.fromEntries(others) }) }
      : { publicationId: null, sourceId, providerId }),
    ...(auth && { auth }),
    ...(tls && { tls: { cert_file: resolve(directory, tls.cert_file), key_file: resolve(directory, tls.key_file) } }),
  };
}
