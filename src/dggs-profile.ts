import { pinnedImage, publicationEntries, type FeaturesConfig, type ManagedProvider } from './config.js';

export const dggsRoutes = 'schema|queryables|dggs(/h3(/zones(/[0-9a-f]{15}(/data)?)?)?)?';
export const dggsRelation = '[ogc-rel:dggrs-list]';
export const dggsDataRoute = '/dggs/h3/zones';
export const dggsFiles = '/etc/pydggsapi/gis';

const coordinate = '([+-]|%2[bB])?([0-9]+([.][0-9]*)?|[.][0-9]+)([eE]([+-]|%2[bB])?[0-9]+)?';
export const dggsZoneParameters = [
  { name: 'bbox', pattern: `${coordinate}((,|%2[cC])${coordinate}){3}`, required: true,
    description: 'Four CRS84 coordinates in west, south, east, north order.', schema: { type: 'string' } },
  { name: 'zone-level', pattern: '([0-9]|1[0-5])', required: true,
    description: 'H3 resolution of the publication.', schema: { type: 'integer', minimum: 0, maximum: 15 } },
  { name: 'compact-zones', pattern: 'false', required: true, schema: { type: 'boolean', enum: [false] } },
  { name: 'f', pattern: 'geojson', schema: { type: 'string', enum: ['geojson'] } },
  { name: 'geometry', pattern: 'zone-region', schema: { type: 'string', enum: ['zone-region'] } },
  { name: 'limit', pattern: '[1-9][0-9]{0,4}', schema: { type: 'integer', minimum: 1, maximum: 99999, default: 1000 } },
];

export function dggsConfig(config: FeaturesConfig, provider: string) {
  const collections = publicationEntries(config).filter(([, item]) => item.provider === provider);
  const sources = Object.fromEntries(collections.map(([, { source }]) => {
    const file = config.dggsSources![source]!;
    return [source, { filepath: dggsSnapshotPath(source), id_col: file.id_field, data_cols: file.properties }];
  }));
  return {
    collections: Object.fromEntries(collections.map(([id, item], index) => {
      const level = config.dggsSources![item.source]!.resolution;
      return [index + 1, { [id]: {
        title: item.title, description: item.description, extent: { spatial: { bbox: [item.extent] } },
        collection_provider: {
          providerId: 'parquet', dggrsId: 'h3', min_refinement_level: level, max_refinement_level: level,
          datasource_id: item.source,
        },
      } }];
    })),
    dggrs: { 1: { h3: {
      title: 'H3', description: 'H3 discrete global grid', crs: 'wgs84', shapeType: 'hexagon',
      definition_link: 'https://h3geo.org/', defaultDepth: 0, classname: 'h3_dggrs_provider.H3Provider',
    } } },
    collection_providers: { 1: { parquet: {
      classname: 'parquet_collection_provider.ParquetCollectionProvider', datasources: sources,
    } } },
  };
}

export function dggsSnapshotPath(id: string) {
  return `/source/${id}/snapshot.parquet`;
}

// TinyDB opens its configuration for writing. The service gets a disposable
// copy while its input files and the archived platform configuration stay read-only.
export const runDggs = `#!/bin/sh
set -eu
export DGGS_API_CONFIG="$(mktemp)"
cp ${dggsFiles}/config.json "$DGGS_API_CONFIG"
if [ "$1" = "--check" ]; then
  exec python ${dggsFiles}/validate.py
fi
exec uvicorn pydggsapi.api:app --host 0.0.0.0 --port "$1" --forwarded-allow-ips '*'
`;

export function dggsService(provider: ManagedProvider, root: string, directory: string) {
  const { port, readiness } = provider.api;
  return {
    image: pinnedImage(provider),
    platform: 'linux/amd64',
    restart: 'unless-stopped',
    entrypoint: ['/bin/sh', `${dggsFiles}/run.sh`],
    command: [String(port)],
    environment: { DGGS_PREFIX: root, OPENAPI_URL: `${root}/openapi`, DOCS_URL: `${root}/docs` },
    volumes: [{ type: 'bind', source: directory, target: dggsFiles, read_only: true, bind: { create_host_path: false } }],
    healthcheck: {
      test: ['CMD', 'python', '-c',
        `from urllib.request import urlopen; urlopen('http://127.0.0.1:${port}${root}${readiness}',timeout=2).close()`],
      interval: '2s', timeout: '3s', retries: 25,
    },
  };
}
