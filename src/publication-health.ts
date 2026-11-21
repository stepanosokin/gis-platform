import { postgisSource, type FeaturesConfig, type Publication } from './config.js';

export interface HealthEndpoint {
  service: string;
  port: number;
  path: string;
  martin: boolean;
  python?: string;
}

export interface PublicationHealth {
  instance: HealthEndpoint;
  renderer?: HealthEndpoint;
  source: HealthEndpoint;
}

export function providerServiceName(config: FeaturesConfig, id: string) {
  return config.providers?.[id]?.image ? `provider-${id}` : 'pygeoapi';
}

export function publicationHealth(config: FeaturesConfig, id: string, publication: Publication): PublicationHealth {
  function endpoint(providerId: string, path: string): HealthEndpoint {
    const provider = config.providers?.[providerId];
    const api = provider?.image ? provider.api : undefined;
    const base = api?.base_path;
    return {
      service: providerServiceName(config, providerId),
      port: api?.port ?? 80,
      path: (base && base !== '/' ? base : '') + path,
      martin: provider?.type === 'martin',
      ...(provider?.type === 'pydggsapi' && { python: 'python' }),
    };
  }
  const rendererId = publication.tile_provider;
  const dynamic = Boolean(postgisSource(config, publication.source));
  const collection = `/collections/${id}`;
  const sourcePath = {
    features: `${collection}/items?f=json&limit=1`,
    maps: `${collection}/map?f=png&width=32&height=32&bbox=${publication.extent.join(',')}`,
    mvt: dynamic ? martinTile(id, publication.extent) : `/${id}`,
    tiles: martinTile(id, publication.extent),
    dggs: `${collection}/schema`,
  }[publication.protocol];
  return {
    instance: endpoint(publication.provider, publication.protocol === 'mvt' ? '/health' :
      publication.protocol === 'dggs' ? '/conformance' : '/openapi?f=json'),
    ...(rendererId && { renderer: endpoint(rendererId, '/health') }),
    source: endpoint(rendererId ?? publication.provider, sourcePath),
  };
}

function martinTile(id: string, [west, south, east, north]: Publication['extent']) {
  // Probe a small tile inside the publication's extent. Martin returns 204 for an empty tile.
  const zoom = 14;
  const size = 2 ** zoom;
  const longitude = (west + east) / 2;
  const latitude = Math.max(-85, Math.min(85, (south + north) / 2)) * Math.PI / 180;
  const x = Math.max(0, Math.min(size - 1, Math.floor((longitude + 180) / 360 * size)));
  const y = Math.floor((1 - Math.asinh(Math.tan(latitude)) / Math.PI) / 2 * size);
  return `/${id}/${zoom}/${x}/${y}`;
}

export function healthUrl({ service, port, path }: HealthEndpoint, host = service) {
  return `http://${host}:${port}${path}`;
}

export async function probeHealth(endpoint: HealthEndpoint) {
  try {
    const response = await fetch(healthUrl(endpoint), { redirect: 'error', signal: AbortSignal.timeout(3000) });
    await response.body?.cancel();
    return response.ok;
  } catch {
    return false;
  }
}

export async function publicationChecks(publications: Record<string, PublicationHealth>,
  probe: (endpoint: HealthEndpoint) => Promise<boolean>, publicationId?: string) {
  const instances = new Map<string, Promise<boolean>>();
  const checkInstance = (endpoint: HealthEndpoint) => {
    const url = healthUrl(endpoint);
    let result = instances.get(url);
    if (!result) {
      result = probe(endpoint);
      instances.set(url, result);
    }
    return result;
  };
  return Promise.all(Object.entries(publications).filter(([id]) => publicationId === undefined || id === publicationId)
    .map(async ([publicationId, { instance, renderer, source }]) => {
      const [instanceReady, rendererReady] = await Promise.all([checkInstance(instance), !renderer || checkInstance(renderer)]);
      const ready = instanceReady && rendererReady;
      return {
        publicationId, instance: ready ? 'ready' : 'unavailable',
        source: ready ? await probe(source) ? 'ready' : 'unavailable' : 'unknown',
      };
    }));
}
