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

  const config: unknown = document.toJS({ maxAliasCount: 0 });
  if (!validate(config)) {
    const errors = (validate.errors ?? []).map(({ instancePath, message, params }) => {
      const field = params.additionalProperty ?? params.missingProperty;
      return `${instancePath || '/'} ${message}${field ? ` (${field})` : ''}`;
    });
    throw new Error(errors.join('; '));
  }

  const [[publicationId, publication]] = Object.entries(config.publications) as [[string, Publication]];
  const source = Object.hasOwn(config.sources, publication.source) && config.sources[publication.source];
  if (!source) throw new Error(`Publication '${publicationId}' references unknown source '${publication.source}'.`);
  if (!Object.hasOwn(config.providers, publication.provider)) {
    throw new Error(`Publication '${publicationId}' references unknown provider '${publication.provider}'.`);
  }
  const [west, south, east, north] = publication.extent;
  if (west > east || south > north) throw new Error(`Publication '${publicationId}' has an invalid extent.`);

  const { host, port } = config.server;
  const publicUrl = new URL(`/features`, `http://${host}:${port}`).href;
  return { port, publicUrl, sourcePath: resolve(dirname(filename), source.path), publicationId, publication };
}
