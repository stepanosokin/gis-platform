import { isIP } from 'node:net';
import { pinnedImage, postgisSecretName, postgisSource, providerRoot, publicationsForProvider, tileArchive, type FeaturesConfig,
  type ManagedProvider, type PostgisConnection, type TileArchiveSource } from './config.js';

export function tileArchivePath(id: string, source: TileArchiveSource) {
  return `/source/${id}/tiles.${source.type}`;
}

function databaseVariable(connection: string) {
  return `GIS_MARTIN_DATABASE_URL_${connection.replaceAll('-', '_')}`;
}

export function martinConfig(config: FeaturesConfig, id: string) {
  const provider = config.providers?.[id];
  if (!provider?.image || provider.type !== 'martin') return undefined;
  const base = provider.api.base_path;
  const publications = publicationsForProvider(config, id);
  const archives: Partial<Record<TileArchiveSource['type'], { sources: Record<string, string> }>> = {};
  const tables = new Map<string, Record<string, object>>();
  for (const [key, publication] of publications) {
    const archive = tileArchive(config, publication.source);
    if (archive) {
      (archives[archive.type] ??= { sources: {} }).sources[key] = tileArchivePath(publication.source, archive);
      continue;
    }
    const source = postgisSource(config, publication.source)!;
    if (!tables.has(source.connection)) tables.set(source.connection, {});
    tables.get(source.connection)![key] = { schema: source.schema, table: source.relation, geometry_column: source.geometry_field,
      layer_id: key, bounds: publication.extent, srid: 0,
      properties: Object.fromEntries([source.id_field, ...publication.mvt_properties ?? []].map((field) => [field, field])) };
  }
  return {
    listen_addresses: `0.0.0.0:${provider.api.port}`,
    base_path: providerRoot(config, id, 'mvt'),
    ...(base !== '/' && { route_prefix: base }),
    cache: 'disable',
    cors: false,
    ...archives,
    ...(tables.size && {
      postgres: [...tables].map(([connection, publishedTables]) => ({
        connection_string: '${' + databaseVariable(connection) + '}', auto_publish: false, auto_bounds: 'skip',
        reload_interval: '0s', tables: publishedTables,
      })),
    }),
  };
}

export function martinService(provider: ManagedProvider, directory: string,
  connections: (readonly [string, PostgisConnection])[], secrets: { source: string }[] | undefined) {
  const { base_path: base, port } = provider.api;
  const argumentsForConnections = connections.flatMap(([id, settings]) => {
    const host = isIP(settings.host) === 6 ? `[${settings.host}]` : settings.host;
    const address = `@${host}:${settings.port}/${encodeURIComponent(settings.database)}` +
      '?options=-c%20default_transaction_read_only%3Don';
    return [databaseVariable(id), postgisSecretName(id), encodeURIComponent(settings.user), address];
  });
  const localApi = `http://127.0.0.1:${port}${base === '/' ? '' : base}`;
  return {
    image: pinnedImage(provider),
    restart: 'unless-stopped',
    entrypoint: ['/bin/sh', '/etc/martin/gis/run.sh', localApi,
      ...(secrets ? [...argumentsForConnections, '--'] : ['', ''])],
    ...(secrets && { secrets }),
    volumes: [{ type: 'bind', source: directory, target: '/etc/martin/gis', read_only: true,
      bind: { create_host_path: false } }],
    healthcheck: {
      test: ['CMD', 'wget', '-q', '-T', '2', '-O', '/dev/null',
        `${localApi}/health`],
      interval: '2s', timeout: '3s', retries: 25,
    },
  };
}

// The mounted secret is available only in the provider container. Martin expands the URI in YAML.
export const runMartin = `set -eu
api=$1
shift
# File-only services keep the two empty arguments used by previously saved revisions.
if [ -z "$1" ]; then
    shift 2
else
    while [ "$1" != '--' ]; do
        password=$(cat "/run/secrets/$2")
        password=$(printf '%s' "$password" | sed 's/\\r$//' | od -An -v -tx1 | tr -s '[:space:]' '%' | sed 's/%$//')
        export "$1=postgresql://$3:$password$4"
        shift 4
    done
    shift
fi
config=/etc/martin/gis/martin.yaml
if [ "$#" -eq 0 ]; then
    exec martin --config "$config"
fi
[ "$1" = "--check" ]
shift
martin --config "$config" >&2 &
server=$!
trap 'kill "$server" 2>/dev/null || true' EXIT
attempt=0
until wget -q -T 2 -O /dev/null "$api/health"; do
    kill -0 "$server"
    attempt=$((attempt + 1))
    [ "$attempt" -lt 35 ]
    sleep 1
done
catalog=$(wget -q -T 3 -O - "$api/catalog")
printf '%s\\n' "$catalog"
for id; do
    document=$(wget -q -T 3 -O - "$api/$id")
    printf '%s\\n' "$document"
done
`;

export function checkTileJson(body: string, url: string, id: string,
  expectedLayers: 'raster' | 'vector' | 'archive' | { idField: string }) {
  const document = JSON.parse(body) as { tiles?: string[]; scheme?: string;
    data?: string[]; grids?: string[]; vector_layers?: { id: string; fields: Record<string, string> }[] | null };
  const layers = document.vector_layers;
  const noVectorLayers = layers == null || (Array.isArray(layers) && layers.length === 0);
  let validLayers = noVectorLayers;
  if (typeof expectedLayers === 'object') {
    const layer = layers?.find((entry) => entry.id === id);
    validLayers = Boolean(layer?.fields && Object.hasOwn(layer.fields, expectedLayers.idField));
  } else if (expectedLayers === 'vector' || (expectedLayers === 'archive' && !noVectorLayers)) {
    validLayers = Array.isArray(layers) && layers.length > 0 && layers.every((layer) =>
      typeof layer?.id === 'string' && layer.id.trim() !== '' && layer.fields &&
      typeof layer.fields === 'object' && !Array.isArray(layer.fields) &&
      Object.values(layer.fields).every((field) => typeof field === 'string'));
  }
  if (document.tiles?.length !== 1 || document.tiles[0] !== `${url}/{z}/{x}/{y}` ||
      document.data?.length || document.grids?.length ||
      (document.scheme && document.scheme !== 'xyz') || !validLayers) {
    throw new Error(`Publication '${id}' has invalid TileJSON.`);
  }
}
