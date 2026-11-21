import { isIP } from 'node:net';
import { pinnedImage, postgisSource, providerRoot, publicationEntries, tileArchive, type FeaturesConfig,
  type ManagedProvider, type TileArchiveSource } from './config.js';

export function tileArchivePath(id: string, source: TileArchiveSource) {
  return `/source/${id}/tiles.${source.type}`;
}

export function martinConfig(config: FeaturesConfig, id: string) {
  const provider = config.providers?.[id];
  if (!provider?.image || provider.type !== 'martin') return undefined;
  const base = provider.api.base_path;
  const publications = publicationEntries(config).filter(([, publication]) => publication.provider === id);
  const archives: Partial<Record<TileArchiveSource['type'], { sources: Record<string, string> }>> = {};
  const tables = Object.fromEntries(publications.flatMap(([key, publication]) => {
    const archive = tileArchive(config, publication.source);
    if (archive) {
      (archives[archive.type] ??= { sources: {} }).sources[key] = tileArchivePath(publication.source, archive);
      return [];
    }
    const source = postgisSource(config, publication.source)!;
    return [[key, { schema: source.schema, table: source.relation, geometry_column: source.geometry_field,
        layer_id: key, bounds: publication.extent, srid: 0,
        properties: Object.fromEntries([source.id_field, ...publication.mvt_properties ?? []].map((field) => [field, field])) }]];
  }));
  return {
    listen_addresses: `0.0.0.0:${provider.api.port}`,
    base_path: providerRoot(config, id),
    ...(base !== '/' && { route_prefix: base }),
    cache: 'disable',
    cors: false,
    ...archives,
    ...(Object.keys(tables).length && {
      postgres: { connection_string: '${GIS_MARTIN_DATABASE_URL}', auto_publish: false, auto_bounds: 'skip',
        reload_interval: '0s', tables },
    }),
  };
}

export function martinService(provider: ManagedProvider, directory: string, connection: { source: string; target: string }[] | undefined) {
  const { base_path: base, port } = provider.api;
  const settings = provider.postgis;
  const host = settings && (isIP(settings.host) === 6 ? `[${settings.host}]` : settings.host);
  const address = settings ? `@${host}:${settings.port}/${encodeURIComponent(settings.database)}` +
    '?options=-c%20default_transaction_read_only%3Don' : '';
  const localApi = `http://127.0.0.1:${port}${base === '/' ? '' : base}`;
  return {
    image: pinnedImage(provider),
    restart: 'unless-stopped',
    entrypoint: ['/bin/sh', '/etc/martin/gis/run.sh', localApi,
      connection && settings ? encodeURIComponent(settings.user) : '', address],
    ...(connection && { secrets: connection }),
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
if [ -n "$2" ]; then
    password=$(cat /run/secrets/postgis_password)
    password=$(printf '%s' "$password" | sed 's/\\r$//' | od -An -v -tx1 | tr -s '[:space:]' '%' | sed 's/%$//')
    export GIS_MARTIN_DATABASE_URL="postgresql://$2:$password$3"
fi
shift 3
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

export function checkTileJson(body: string, url: string, id: string, idField?: string) {
  const document = JSON.parse(body) as { tiles?: string[]; scheme?: string;
    data?: string[]; grids?: string[]; vector_layers?: { id: string; fields: Record<string, string> }[] };
  const layer = document.vector_layers?.find((entry) => entry.id === id);
  const validLayers = idField === undefined ? !document.vector_layers?.length :
    layer?.fields && Object.hasOwn(layer.fields, idField);
  if (document.tiles?.length !== 1 || document.tiles[0] !== `${url}/{z}/{x}/{y}` ||
      document.data?.length || document.grids?.length ||
      (document.scheme && document.scheme !== 'xyz') || !validLayers) {
    throw new Error(`Publication '${id}' has invalid TileJSON.`);
  }
}
