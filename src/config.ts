import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { Ajv } from 'ajv';
import { parseDocument } from 'yaml';
import schema from './platform.schema.json' with { type: 'json' };

export interface Publication {
  source: string;
  provider: string;
  protocol: 'features';
  access: 'public' | 'registered';
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

export type AuthConfig = {
  secret_file: string;
  postgres_password_file: string;
} & ({ mode: 'development'; mailpit_port?: number } | { mode: 'production'; smtp: SmtpConfig });

export interface FeaturesConfig {
  port: number;
  publicUrl: string;
  sourcePath: string;
  publicationId: string;
  publication: Publication;
  additionalPublications?: Record<string, Publication>;
  auth?: AuthConfig;
  tls?: TlsConfig;
}

export function publicationEntries(config: FeaturesConfig): [string, Publication][] {
  return [[config.publicationId, config.publication], ...Object.entries(config.additionalPublications ?? {})];
}

const validate = new Ajv({ allErrors: true, ownProperties: true }).compile<PlatformConfig>(schema);

export async function readFeaturesConfig(filename: string): Promise<FeaturesConfig> {
  const document = parseDocument(await readFile(filename, 'utf8'));
  if (document.errors.length) throw new Error(document.errors[0]?.message);

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
    if (access === 'registered' && !config.auth) throw new Error(`Publication '${id}' requires auth configuration.`);
  }
  const [first, ...others] = entries;
  if (!first) throw new Error('Expected at least one publication.');
  const [publicationId, publication] = first;
  const sourceConfig = config.sources[publication.source];
  if (!sourceConfig) throw new Error(`Expected source '${publication.source}'.`);

  const { host, port, tls } = config.server;
  const directory = dirname(filename);
  const auth = config.auth;
  if (auth) {
    auth.secret_file = resolve(directory, auth.secret_file);
    auth.postgres_password_file = resolve(directory, auth.postgres_password_file);
    if (auth.mode === 'production' && auth.smtp.password_file) {
      auth.smtp.password_file = resolve(directory, auth.smtp.password_file);
    }
  }
  return {
    port,
    publicUrl: new URL('/features', `${tls ? 'https' : 'http'}://${host}:${port}`).href,
    sourcePath: resolve(directory, sourceConfig.path),
    publicationId,
    publication,
    ...(others.length > 0 && { additionalPublications: Object.fromEntries(others) }),
    ...(auth && { auth }),
    ...(tls && { tls: { cert_file: resolve(directory, tls.cert_file), key_file: resolve(directory, tls.key_file) } }),
  };
}
