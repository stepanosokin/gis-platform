import { execFile } from 'node:child_process';
import { mkdir, open, readFile, writeFile } from 'node:fs/promises';
import { get as getHttp } from 'node:http';
import { get as getHttps } from 'node:https';
import { isIP } from 'node:net';
import { join } from 'node:path';
import { text } from 'node:stream/consumers';
import { setTimeout } from 'node:timers/promises';
import { checkServerIdentity } from 'node:tls';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { publicationEntries, type FeaturesConfig } from './config.js';

const run = promisify(execFile);
const composeFile = (name: string) => fileURLToPath(new URL(`../${name}`, import.meta.url));

function pygeoapiConfig(config: FeaturesConfig) {
  const { publicUrl } = config;
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
        description: 'OGC API Features collections',
        keywords: ['features', 'geospatial'],
        terms_of_service: publicUrl,
        url: publicUrl,
      },
      license: { name: 'Data license unspecified', url: publicUrl },
      provider: { name: 'GIS Platform', url: publicUrl },
      contact: { name: 'GIS Platform', url: publicUrl },
    },
    resources: Object.fromEntries(publicationEntries(config).map(([id, publication]) => [id, {
        type: 'collection',
        title: publication.title,
        description: publication.description,
        keywords: [],
        links: [],
        extents: {
          spatial: { bbox: publication.extent, crs: 'http://www.opengis.net/def/crs/OGC/1.3/CRS84' },
        },
        providers: [{ type: 'feature', name: 'GeoJSON', data: '/source/data.geojson', id_field: 'id' }],
    }])),
  };
}

function caddyConfig(config: FeaturesConfig) {
  const site = config.tls ? `https://${new URL(config.publicUrl).hostname}:443` : ':80';
  const tlsOptions = config.tls ? '\n\tauto_https disable_redirects' : '';
  const certificate = config.tls ? '\n\ttls /run/secrets/tls_cert /run/secrets/tls_key' : '';
  const publications = publicationEntries(config);
  const registered = publications.filter(([, publication]) => publication.access === 'registered').map(([id]) => id);
  const publicIds = publications.filter(([, publication]) => publication.access === 'public').map(([id]) => id);
  const collectionRoute = (ids: string[]) => `collections/(${ids.join('|')})(/(schema|queryables|items(/.+)?))?`;
  const publicRoutes = ['conformance', 'static/.+'];
  if (!registered.length) publicRoutes.push('openapi', 'collections');
  if (publicIds.length) publicRoutes.push(collectionRoute(publicIds));

  const featuresHtmlPolicy = config.auth ? `
				header_down Content-Security-Policy "script-src 'none'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'"
				header_down X-Content-Type-Options nosniff` : '';
  const proxyFeatures = `uri strip_prefix /features
			reverse_proxy pygeoapi:80 {
				header_up -Cookie
				header_up -Authorization
				header_down Cache-Control no-store${featuresHtmlPolicy}
			}`;
  const protectedRoutes = registered.length ? `
	@metadata {
		method GET HEAD
		path /features/openapi /features/collections
	}
	handle @metadata {
		reverse_proxy access:3000
	}
	@registered {
		method GET HEAD
		path_regexp ^/features/${collectionRoute(registered)}$
	}
	handle @registered {
		route {
			forward_auth access:3000 {
				uri /internal/authorize
			}
			${proxyFeatures}
		}
	}
` : '';
  const accounts = config.auth ? `
	@accounts path /account /account/* /api/auth/*
	handle @accounts {
		reverse_proxy access:3000 {
			@accessFailure status 500 502 504
			handle_response @accessFailure {
				header Cache-Control no-store
				header Content-Type application/json
				respond \`{"code":"ServiceUnavailable"}\` 503
			}
		}
	}
` : '';
  return `{
	admin off${tlsOptions}
}

${site} {${certificate}
${accounts}
${protectedRoutes}
	@features {
		method GET HEAD
		path_regexp ^/features(/?|/(${publicRoutes.join('|')}))$
	}
	handle @features {
		route {
			${proxyFeatures}
		}
	}
	handle {
		header Cache-Control no-store
		respond 404
	}
	handle_errors 5xx {
		header Cache-Control no-store
		header Content-Type application/json
		respond \`{"code":"ServiceUnavailable"}\` 503
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
  if (config.auth) {
    const { auth } = config;
    const secret = (await readFile(auth.secret_file, 'utf8')).trim();
    if (Buffer.byteLength(secret) < 32) throw new Error('The auth secret file must contain at least 32 bytes.');
    if (!(await readFile(auth.postgres_password_file, 'utf8')).trim()) {
      throw new Error('The PostgreSQL password file is empty.');
    }
    const smtp = auth.mode === 'development'
      ? { host: 'mailpit', port: 1025, from: 'GIS Platform <accounts@gis-platform.test>' }
      : { host: auth.smtp.host, port: auth.smtp.port, from: auth.smtp.from,
        secure: auth.smtp.secure, username: auth.smtp.username };
    await writeFile(join(revisionDirectory, 'access.json'), JSON.stringify({
      origin: new URL(config.publicUrl).origin, production: auth.mode === 'production', smtp,
      publications: Object.fromEntries(publicationEntries(config).map(([id, { access }]) => [id, access])),
    }));
    if (auth.mode === 'production' && auth.smtp.password_file) {
      await writeFile(join(revisionDirectory, 'compose.smtp.json'), JSON.stringify({
        services: { access: { secrets: ['smtp_password'] } },
        secrets: { smtp_password: { file: auth.smtp.password_file } },
      }));
    }
  }
  await Promise.all([
    writeFile(join(revisionDirectory, 'pygeoapi.yml'), JSON.stringify(pygeoapiConfig(config), null, 2)),
    writeFile(join(revisionDirectory, 'Caddyfile'), caddyConfig(config)),
  ]);
}

export async function compose(config: FeaturesConfig, revisionDirectory: string, ...args: string[]) {
  const files = [composeFile('compose.yaml')];
  if (config.tls) files.push(composeFile('compose.tls.yaml'));
  if (config.auth) {
    files.push(composeFile('compose.auth.yaml'));
    if (config.auth.mode === 'development') files.push(composeFile('compose.mailpit.yaml'));
    else if (config.auth.smtp.password_file) files.push(join(revisionDirectory, 'compose.smtp.json'));
  }
  await run('docker', ['compose', ...files.flatMap((file) => ['-f', file]), ...args], {
    env: {
      ...process.env,
      GIS_PUBLIC_PORT: String(config.port),
      GIS_CADDY_PORT: config.tls ? '443' : '80',
      GIS_TLS_CERT_FILE: config.tls?.cert_file,
      GIS_TLS_KEY_FILE: config.tls?.key_file,
      GIS_PUBLICATION_ID: config.publicationId,
      GIS_REVISION_DIR: revisionDirectory,
      GIS_SOURCE_FILE: config.sourcePath,
      GIS_AUTH_SECRET_FILE: config.auth?.secret_file,
      GIS_POSTGRES_PASSWORD_FILE: config.auth?.postgres_password_file,
      GIS_MAILPIT_PORT: config.auth?.mode === 'development' ? String(config.auth.mailpit_port ?? 8025) : undefined,
    },
    windowsHide: true,
  });
}

function probeCollection(origin: URL, path: string, certificate: Buffer | undefined) {
  return new Promise<{ status?: number; cacheControl?: string; body: string }>((resolve, reject) => {
    const url = new URL(path, origin);
    url.hostname = '127.0.0.1';
    const get = certificate ? getHttps : getHttp;
    const request = get(url, {
      headers: { Host: origin.host },
      signal: AbortSignal.timeout(2000),
      ...(certificate && {
        ca: certificate,
        allowPartialTrustChain: true,
        ...(isIP(origin.hostname) === 0 && { servername: origin.hostname }),
        checkServerIdentity: (_hostname, peer) => checkServerIdentity(origin.hostname, peer),
      }),
    }, (response) => {
      text(response).then((body) => resolve({ status: response.statusCode,
        cacheControl: response.headers['cache-control'], body }), reject);
    });
    request.on('error', reject);
  });
}

export async function startFeaturesStack(config: FeaturesConfig, revisionDirectory: string) {
  const origin = new URL(config.publicUrl);
  const certificate = config.tls ? await readFile(config.tls.cert_file) : undefined;
  await compose(config, revisionDirectory, 'up', '-d', '--remove-orphans', '--wait', '--wait-timeout', '65',
    ...(config.auth ? ['--build'] : []));

  const collections = publicationEntries(config).map(([id, { access }]) => ({
    id, access, path: `/features/collections/${id}?f=json`,
  }));
  let failure = 'no response';
  for (let attempt = 0; attempt < 15; attempt++) {
    try {
      for (const { id, access, path } of collections) {
        const response = await probeCollection(origin, path, certificate);
        const expectedStatus = access === 'public' ? 200 : 401;
        if (response.status !== expectedStatus || response.cacheControl !== 'no-store') {
          throw new Error(`${id}: expected HTTP ${expectedStatus} and no-store, got HTTP ${response.status}.`);
        }
        const collection = JSON.parse(response.body) as { id?: string; code?: string };
        if (access === 'public' ? collection.id !== id : collection.code !== 'Unauthorized') {
          throw new Error(`${id}: unexpected Features response.`);
        }
      }
      return;
    } catch (error) {
      failure = String(error);
    }
    await setTimeout(500);
  }
  throw new Error(`The publications did not become ready through Caddy at ${config.publicUrl}: ${failure}.`);
}
