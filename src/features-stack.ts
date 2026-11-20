import { execFile } from 'node:child_process';
import { mkdir, open, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type { FeaturesConfig } from './config.js';

const run = promisify(execFile);
const composeFile = fileURLToPath(new URL('../compose.yaml', import.meta.url));

function pygeoapiConfig(config: FeaturesConfig) {
  const { publication, publicationId, publicUrl } = config;
  return {
    server: {
      bind: { host: '0.0.0.0', port: 80 },
      url: publicUrl,
      mimetype: 'application/json; charset=UTF-8',
      encoding: 'utf-8',
      languages: ['en-US'],
      limits: { default_items: 20, max_items: 100 },
      map: {
        url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap contributors</a>',
      },
      admin: false,
    },
    logging: { level: 'INFO' },
    metadata: {
      identification: {
        title: 'GIS Platform Features',
        description: 'Public OGC API Features collections',
        keywords: ['features', 'geospatial'],
        terms_of_service: publicUrl,
        url: publicUrl,
      },
      license: { name: 'Data license unspecified', url: publicUrl },
      provider: { name: 'GIS Platform', url: publicUrl },
      contact: { name: 'GIS Platform', url: publicUrl },
    },
    resources: {
      [publicationId]: {
        type: 'collection',
        title: publication.title,
        description: publication.description,
        keywords: [],
        links: [],
        extents: {
          spatial: { bbox: publication.extent, crs: 'http://www.opengis.net/def/crs/OGC/1.3/CRS84' },
        },
        providers: [{ type: 'feature', name: 'GeoJSON', data: '/source/data.geojson', id_field: 'id' }],
      },
    },
  };
}

function caddyConfig(publicationId: string) {
  return `{
	admin off
}

:80 {
	@features {
		method GET HEAD
		path_regexp ^/features(/?|/(openapi|conformance|static/.+|collections(/${publicationId}(/(schema|queryables|items(/.+)?))?)?))$
	}
	handle @features {
		uri strip_prefix /features
		reverse_proxy pygeoapi:80 {
			header_down Cache-Control no-store
		}
	}
	handle {
		header Cache-Control no-store
		respond 404
	}
}
`;
}

export async function prepareFeaturesStack(config: FeaturesConfig, revisionDirectory: string) {
  const source = await open(config.sourcePath, 'r');
  try {
    if (!(await source.stat()).isFile()) throw new Error('The GeoJSON source must be a regular file.');
  } finally {
    await source.close();
  }

  await mkdir(revisionDirectory, { recursive: true });
  await Promise.all([
    writeFile(join(revisionDirectory, 'pygeoapi.yml'), JSON.stringify(pygeoapiConfig(config), null, 2)),
    writeFile(join(revisionDirectory, 'Caddyfile'), caddyConfig(config.publicationId)),
  ]);
}

export async function compose(config: FeaturesConfig, revisionDirectory: string, ...args: string[]) {
  await run('docker', ['compose', '-f', composeFile, ...args], {
    env: {
      ...process.env,
      GIS_PUBLIC_PORT: String(config.port),
      GIS_PUBLICATION_ID: config.publicationId,
      GIS_REVISION_DIR: revisionDirectory,
      GIS_SOURCE_FILE: config.sourcePath,
    },
    windowsHide: true,
  });
}

export async function startFeaturesStack(config: FeaturesConfig, revisionDirectory: string) {
  await compose(config, revisionDirectory, 'up', '-d', '--wait', '--wait-timeout', '65');

  const collectionUrl = `http://127.0.0.1:${config.port}/features/collections/${config.publicationId}`;
  let failure = 'no response';
  for (let attempt = 0; attempt < 15; attempt++) {
    try {
      const response = await fetch(`${collectionUrl}?f=json`, { signal: AbortSignal.timeout(2_000) });
      if (response.ok && response.headers.get('cache-control') === 'no-store') {
        const collection = await response.json() as { id?: string };
        if (collection.id === config.publicationId) return;
        failure = 'unexpected collection ID';
      } else {
        failure = `HTTP ${response.status}, Cache-Control: ${response.headers.get('cache-control') ?? '(missing)'}`;
        await response.body?.cancel();
      }
    } catch (error) {
      failure = String(error);
    }
    await setTimeout(500);
  }
  throw new Error(`The publication did not become ready through Caddy at ${collectionUrl}: ${failure}.`);
}
