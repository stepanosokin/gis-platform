import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { Ajv } from 'ajv';
import { parseDocument } from 'yaml';
import schema from './platform.schema.json' with { type: 'json' };

interface Publication {
  source: string;
  provider: string;
  protocol: 'features';
  access: 'public';
  title: string;
  description: string;
  extent: [number, number, number, number];
}

interface PlatformConfig {
  schema_version: 1;
  server: { host: string; port: number };
  sources: Record<string, { type: 'geojson'; path: string }>;
  providers: Record<string, { type: 'pygeoapi' }>;
  publications: Record<string, Publication>;
}

export interface FeaturesConfig {
  port: number;
  publicUrl: string;
  sourcePath: string;
  publicationId: string;
  publication: Publication;
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

  const entry = Object.entries(config.publications)[0];
  if (!entry) throw new Error('Expected one publication.');
  const [publicationId, { source, provider, protocol, access, title, description, extent }] = entry;
  const sourceConfig = Object.hasOwn(config.sources, source) && config.sources[source];
  if (!sourceConfig) throw new Error(`Publication '${publicationId}' references unknown source '${source}'.`);
  if (!Object.hasOwn(config.providers, provider)) {
    throw new Error(`Publication '${publicationId}' references unknown provider '${provider}'.`);
  }
  const [west, south, east, north] = extent;
  if (west > east || south > north) throw new Error(`Publication '${publicationId}' has an invalid extent.`);

  const { host, port } = config.server;
  return {
    port,
    publicUrl: new URL('/features', `http://${host}:${port}`).href,
    sourcePath: resolve(dirname(filename), sourceConfig.path),
    publicationId,
    publication: { source, provider, protocol, access, title, description, extent },
  };
}
