import { execFile } from 'node:child_process';
import { createHash, X509Certificate } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { get as getHttp } from 'node:http';
import { get as getHttps } from 'node:https';
import { isIP } from 'node:net';
import { basename, join } from 'node:path';
import { text } from 'node:stream/consumers';
import { setTimeout } from 'node:timers/promises';
import { checkServerIdentity, createSecureContext } from 'node:tls';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { parse } from 'yaml';
import { publicationEntries, type FeaturesConfig } from './config.js';

const run = promisify(execFile);
const composeFile = (name: string) => fileURLToPath(new URL(`../${name}`, import.meta.url));
let project: string | undefined;

export async function resolveComposeProject() {
  const { stdout } = await run('docker', ['compose', '-f', composeFile('compose.yaml'), 'config', '--format', 'json'],
    { windowsHide: true });
  const config = JSON.parse(stdout) as { name?: string };
  if (!config.name) throw new Error('Compose did not report a project name.');
  project = config.name;
  return project;
}

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

export function providerConfigurationChanged(candidate: FeaturesConfig, previous: FeaturesConfig | null) {
  return !previous || candidate.sourcePath !== previous.sourcePath ||
    JSON.stringify(pygeoapiConfig(candidate)) !== JSON.stringify(pygeoapiConfig(previous));
}

function caddyConfig(config: FeaturesConfig) {
  const site = config.tls ? `https://${new URL(config.publicUrl).hostname}:443` : ':80';
  const tlsOptions = config.tls ? '\n\tauto_https disable_redirects' : '';
  const certificate = config.tls ? '\n\ttls /run/secrets/tls_cert /run/secrets/tls_key' : '';
  const publications = publicationEntries(config);
  const protectedIds = publications.filter(([, publication]) => publication.access !== 'public').map(([id]) => id);
  const publicIds = publications.filter(([, publication]) => publication.access === 'public').map(([id]) => id);
  const collectionRoute = (ids: string[]) => `collections/(${ids.join('|')})(/(schema|queryables|items(/.+)?))?`;
  const allCollections = collectionRoute(publications.map(([id]) => id));
  const journal = `
	log
	@loggedFeatures path_regexp ^/features/(openapi|collections|${allCollections})$
	@unloggedFeatures not path_regexp ^/features/(openapi|collections|${allCollections})$
	@loggedPublication path_regexp loggedPublication ^/features/${allCollections}$
	log_skip @unloggedFeatures
	log_append @loggedFeatures requestId {http.request.uuid}
	log_append @loggedPublication publicationId {http.regexp.loggedPublication.1}
	header @loggedFeatures >X-Request-Id {http.request.uuid}
`;
  const publicRoutes = ['conformance', 'static/.+'];
  if (!config.auth) publicRoutes.push('openapi', 'collections');
  if (!config.auth && publicIds.length) publicRoutes.push(collectionRoute(publicIds));

  const featuresHtmlPolicy = config.auth ? `
				header_down Content-Security-Policy "script-src 'none'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'"
				header_down X-Content-Type-Options nosniff` : '';
  const proxyFeatures = `uri strip_prefix /features
			reverse_proxy pygeoapi:80 {
				header_up -Cookie
				header_up -Authorization
				header_down Cache-Control no-store${featuresHtmlPolicy}
			}`;
  const metadataRoutes = config.auth ? `
	@metadata {
		method GET HEAD
		path /features/openapi /features/collections
	}
	handle @metadata {
		route {${protectedIds.length ? '' : '\n\t\t\tvars public_auth_pending true'}
			reverse_proxy access:3000 {
				header_up X-GIS-Request-Id {http.request.uuid}
			}
		}
	}
` : '';
  function publicationRoutes(ids: string[], allowAnonymousFallback: boolean) {
    if (!ids.length) return '';
    const matcher = allowAnonymousFallback ? 'publicPublication' : 'protectedPublication';
    return `
	@${matcher} {
		method GET HEAD
		path_regexp ${matcher} ^/features/${collectionRoute(ids)}$
	}
	handle @${matcher} {
		route {${allowAnonymousFallback ? '\n\t\t\tvars public_auth_pending true' : ''}
			forward_auth access:3000 {
				uri /internal/authorize/{http.regexp.${matcher}.1}
				header_up X-GIS-Request-Id {http.request.uuid}
			}${allowAnonymousFallback ? '\n\t\t\tvars public_auth_pending false' : ''}
			${proxyFeatures}
		}
	}
`;
  }
  const publicAuthFallback = config.auth && (publicIds.length || !protectedIds.length) ? `
		@publicAuthUnavailable vars public_auth_pending true
		handle @publicAuthUnavailable {
			route {
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
  const routes = `
${accounts}
${metadataRoutes}
${config.auth ? publicationRoutes(protectedIds, false) + publicationRoutes(publicIds, true) : ''}
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
`;
  const errors = `
	handle_errors 5xx {
		header X-Request-Id {http.request.uuid}${publicAuthFallback}
		handle {
			header Cache-Control no-store
			header Content-Type application/json
			respond \`{"code":"ServiceUnavailable"}\` 503
		}
	}
`;
  return `{
	admin off${tlsOptions}
	log {
		format filter {
			wrap json
			request delete
			resp_headers delete
		}
	}
}

${site} {${certificate}
${journal}
	route {
		@switching file {
			root /etc/caddy/gis
			try_files closed
		}
		header @switching Cache-Control no-store
		header @switching Content-Type application/json
		respond @switching \`{"code":"ServiceUnavailable"}\` 503
${routes}
	}
${errors}
}

http://:2080 {
	bind 127.0.0.1
	route {
${routes}
	}
${errors}
}
`;
}

interface Revision {
  config: FeaturesConfig;
  directory: string;
}

export async function sourceFingerprint(path: string) {
  const hash = createHash('sha256');
  try {
    for await (const chunk of createReadStream(path)) hash.update(chunk);
    return hash.digest('hex');
  } catch {
    return null;
  }
}

export async function savedSourceFingerprint(directory: string) {
  return readFile(join(directory, 'source.sha256'), 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error;
    return null;
  });
}

export async function archiveLegacyOpenApi({ config, directory }: Revision) {
  const output = await compose(config, directory, 'exec', '-T', 'pygeoapi', 'cat', '/pygeoapi/local.openapi.yml');
  const body = JSON.stringify(parse(output));
  checkOpenApi(body, config, publicationEntries(config).map(([id]) => id));
  await writeFile(join(directory, 'openapi.json'), body);
}

export async function prepareFeaturesStack({ config, directory: revisionDirectory }: Revision,
  options: { previous?: Revision; sourceHash?: string | null; useArchivedOpenApi?: boolean } = {}) {
  const { previous, useArchivedOpenApi } = options;
  await mkdir(revisionDirectory, { recursive: true, mode: 0o700 });
  await rm(join(revisionDirectory, 'provider-directory'), { force: true });
  if (config.tls) {
    const cert = new X509Certificate(await readFile(config.tls.cert_file));
    const hostname = new URL(config.publicUrl).hostname;
    const matches = isIP(hostname) ? cert.checkIP(hostname) : cert.checkHost(hostname);
    const now = Date.now();
    if (!matches || now < Date.parse(cert.validFrom) || now > Date.parse(cert.validTo)) {
      throw new Error('Invalid TLS certificate for the public hostname.');
    }
  }
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
      publicationTitles: Object.fromEntries(publicationEntries(config).map(([id, { title }]) => [id, title])),
      administratorEmails: auth.administrator_emails,
      operators: auth.cli?.operators, version: basename(revisionDirectory),
    }));
    if (auth.mode === 'production' && auth.smtp.password_file) {
      if (!(await readFile(auth.smtp.password_file, 'utf8')).trim()) throw new Error('The SMTP password file is empty.');
      await writeFile(join(revisionDirectory, 'compose.smtp.json'), JSON.stringify({
        services: { access: { secrets: ['smtp_password'] } },
        secrets: { smtp_password: { file: auth.smtp.password_file } },
      }));
    }
    if (auth.cli) {
      const [ca, cert, key] = await Promise.all([auth.cli.ca_file, auth.cli.cert_file, auth.cli.key_file]
        .map((file) => readFile(file)));
      createSecureContext({ ca, cert, key });
      const secretFiles = { cli_ca: auth.cli.ca_file, cli_cert: auth.cli.cert_file, cli_key: auth.cli.key_file };
      await writeFile(join(revisionDirectory, 'compose.admin.json'), JSON.stringify({
        services: { access: {
          ports: [{ target: 3001, published: String(auth.cli.port), host_ip: '127.0.0.1' }],
          secrets: Object.keys(secretFiles),
        } },
        secrets: Object.fromEntries(Object.entries(secretFiles).map(([name, file]) => [name, { file }])),
      }));
    }
  }
  const providerConfig = JSON.stringify(pygeoapiConfig(config), null, 2);
  await writeFile(join(revisionDirectory, 'pygeoapi.yml'), providerConfig);
  await writeFile(join(revisionDirectory, 'Caddyfile'), caddyConfig(config));
  await compose(config, revisionDirectory, 'config', '--quiet');
  await compose(config, revisionDirectory, 'run', '--rm', '--no-deps', '-T', '--entrypoint', 'caddy', 'caddy',
    'validate', '--config', '/etc/caddy/gis/Caddyfile', '--adapter', 'caddyfile');

  if (useArchivedOpenApi) {
    const archived = await readFile(join(revisionDirectory, 'openapi.json'), 'utf8').catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
    });
    if (archived) {
      checkOpenApi(archived, config, publicationEntries(config).map(([id]) => id));
      return;
    }
  }
  const sameSource = previous?.config.sourcePath === config.sourcePath;
  const sourceHash = await sourceFingerprint(config.sourcePath);
  const previousHash = previous && await savedSourceFingerprint(previous.directory);
  if ((options.sourceHash && sourceHash && sourceHash !== options.sourceHash) ||
      (options.sourceHash === null && sameSource && sourceHash && previousHash && sourceHash !== previousHash)) {
    throw new Error('The GeoJSON source changed after planning.');
  }
  if (previous && previousHash && sameSource && (!sourceHash || sourceHash === previousHash) &&
      (!options.sourceHash || options.sourceHash === previousHash) &&
      !providerConfigurationChanged(config, previous.config)) {
    await copyFile(join(previous.directory, 'openapi.json'), join(revisionDirectory, 'openapi.json'));
    const provider = await providerDirectory(previous.directory);
    await writeFile(join(revisionDirectory, 'provider-directory'), basename(provider));
    await writeFile(join(revisionDirectory, 'source.sha256'), previousHash);
    return;
  }
  if (!sourceHash) throw new Error('The GeoJSON source is unavailable.');
  const output = await compose(config, revisionDirectory, 'run', '--rm', '--no-deps', '-T', '--entrypoint', '/bin/sh', 'pygeoapi',
    '-ec', [
      `/venv/bin/python -c "from pygeoapi.provider.geojson import GeoJSONProvider; GeoJSONProvider({'name': 'GeoJSON', 'type': 'feature', 'data': '/source/data.geojson', 'id_field': 'id'}).query(limit=1)" >/dev/null`,
      '/venv/bin/pygeoapi openapi generate "$PYGEOAPI_CONFIG" -f json -of /tmp/openapi.json >/dev/null',
      'cat /tmp/openapi.json',
    ].join('\n'));
  checkOpenApi(output, config, publicationEntries(config).map(([id]) => id));
  await writeFile(join(revisionDirectory, 'openapi.json'), output);
  await writeFile(join(revisionDirectory, 'source.sha256'), sourceHash);
}

async function providerDirectory(directory: string) {
  const revision = await readFile(join(directory, 'provider-directory'), 'utf8').catch(() => undefined);
  return revision && /^plan-[a-f0-9]{64}$/.test(revision) ? join(directory, '..', revision) : directory;
}

export async function compose(config: FeaturesConfig, revisionDirectory: string, ...args: string[]) {
  const files = [composeFile('compose.yaml')];
  if (config.tls) files.push(composeFile('compose.tls.yaml'));
  if (config.auth) {
    files.push(composeFile('compose.auth.yaml'));
    if (config.auth.mode === 'development') files.push(composeFile('compose.mailpit.yaml'));
    else if (config.auth.smtp.password_file) files.push(join(revisionDirectory, 'compose.smtp.json'));
    if (config.auth.cli) files.push(join(revisionDirectory, 'compose.admin.json'));
  }
  const { stdout } = await run('docker', ['compose', ...(project ? ['-p', project] : []),
    ...files.flatMap((file) => ['-f', file]), ...args], {
    env: {
      ...process.env,
      GIS_PUBLIC_PORT: String(config.port),
      GIS_CADDY_PORT: config.tls ? '443' : '80',
      GIS_TLS_CERT_FILE: config.tls?.cert_file,
      GIS_TLS_KEY_FILE: config.tls?.key_file,
      GIS_REVISION_DIR: revisionDirectory,
      GIS_PROVIDER_REVISION_DIR: await providerDirectory(revisionDirectory),
      GIS_SOURCE_FILE: config.sourcePath,
      GIS_AUTH_SECRET_FILE: config.auth?.secret_file,
      GIS_POSTGRES_PASSWORD_FILE: config.auth?.postgres_password_file,
      GIS_MAILPIT_PORT: config.auth?.mode === 'development' ? String(config.auth.mailpit_port ?? 8025) : undefined,
    },
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
  });
  return stdout;
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

function checkOpenApi(body: string, config: FeaturesConfig, ids: string[]) {
  const api = JSON.parse(body) as { openapi?: string; servers?: { url: string }[]; paths?: Record<string, unknown> };
  if (!api.openapi?.startsWith('3.0.') || api.servers?.[0]?.url !== config.publicUrl ||
      ids.some((id) => !api.paths?.[`/collections/${id}/items`])) {
    throw new Error('The generated Features OpenAPI does not match the configuration.');
  }
}

export async function closeGateway(directory: string) {
  await writeFile(join(directory, 'closed'), '');
}

export async function openGateway(directory: string) {
  await rm(join(directory, 'closed'), { force: true });
}

export async function startFeaturesStack(config: FeaturesConfig, revisionDirectory: string) {
  const origin = new URL(config.publicUrl);
  const certificate = config.tls ? await readFile(config.tls.cert_file) : undefined;
  await compose(config, revisionDirectory, 'up', '-d', '--no-deps', 'caddy');
  await compose(config, revisionDirectory, 'up', '-d', '--remove-orphans',
    '--wait', '--wait-timeout', '65', ...(config.auth ? ['--build'] : []), 'pygeoapi',
    ...(config.auth ? ['access', ...(config.auth.mode === 'development' ? ['mailpit'] : [])] : []));

  const collections = publicationEntries(config).map(([id, { access }]) => ({
    id, access, path: `/features/collections/${id}?f=json`,
  }));
  const internal = async (path: string, status: number) => {
    try {
      const body = await compose(config, revisionDirectory, 'exec', '-T', 'caddy', 'wget', '-T', '3', '-S', '-O', '-',
        `http://127.0.0.1:2080${path}`);
      if (status === 200) return body;
    } catch (error) {
      if (status === 401 && error instanceof Error && 'stderr' in error &&
          typeof error.stderr === 'string' && /HTTP\/1\.1 401\b/.test(error.stderr)) return '';
    }
    throw new Error('Candidate gateway returned an unexpected response.');
  };
  for (let attempt = 0; attempt < 15; attempt++) {
    try {
      const gate = await probeCollection(origin, '/features/collections?f=json', certificate);
      if (gate.status !== 503 || gate.cacheControl !== 'no-store') throw new Error('The gateway is not closed.');
      for (const { id, access, path } of collections) {
        const body = await internal(path, access === 'public' ? 200 : 401);
        if (access === 'public') {
          const collection = JSON.parse(body) as { id?: string; links?: { rel: string; href: string }[] };
          if (collection.id !== id || !collection.links?.some(({ rel, href }) =>
            rel === 'items' && href === `${config.publicUrl}/collections/${id}/items?f=json`)) {
            throw new Error('Unexpected Features collection or canonical URL.');
          }
        }
      }
      checkOpenApi(await internal('/features/openapi?f=json', 200), config,
        collections.filter(({ access }) => access === 'public').map(({ id }) => id));
      return;
    } catch (error) {
      if (attempt === 14) throw error;
    }
    await setTimeout(500);
  }
}
