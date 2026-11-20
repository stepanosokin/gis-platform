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
import { builtInProviderId, needsPublicMetadata, pinnedImage, providerRoot, publicationEntries, publicationUrl,
  type FeaturesConfig } from './config.js';

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

function pygeoapiConfig(config: FeaturesConfig, instance = builtInProviderId(config)) {
  const publicUrl = instance ? new URL(providerRoot(config, instance), config.publicUrl).href : config.publicUrl;
  const provider = instance ? config.providers?.[instance] : undefined;
  return {
    server: {
      bind: { host: '0.0.0.0', port: provider?.image ? provider.api.port : 80 },
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
    resources: Object.fromEntries(publicationEntries(config).filter(([, publication]) =>
      publication.provider === instance).map(([id, publication]) => [id, {
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

export function providerConfigurationChanged(candidate: FeaturesConfig, previous: FeaturesConfig | null,
  id = builtInProviderId(candidate)) {
  return !previous || candidate.sourcePath !== previous.sourcePath ||
    JSON.stringify(pygeoapiConfig(candidate, id)) !== JSON.stringify(pygeoapiConfig(previous, id));
}

function caddyConfig(config: FeaturesConfig) {
  const site = config.tls ? `https://${new URL(config.publicUrl).hostname}:443` : ':80';
  const tlsOptions = config.tls ? '\n\tauto_https disable_redirects' : '';
  const certificate = config.tls ? '\n\ttls /run/secrets/tls_cert /run/secrets/tls_key' : '';
  const publications = publicationEntries(config);
  const protectedIds = publications.filter(([, publication]) => publication.access !== 'public').map(([id]) => id);
  const publicIds = publications.filter(([, publication]) => publication.access === 'public').map(([id]) => id);
  const collectionRoute = (ids: string[]) => `collections/(${ids.join('|')})(/(schema|queryables|items(/.+)?))?`;
  const allCollections = publications.length ? collectionRoute(publications.map(([id]) => id)) : '';
  const roots = config.providers ? [...new Set(Object.keys(config.providers).map((id) => providerRoot(config, id)))] : ['/features'];
  const rootPattern = roots.length ? `(?:${roots.join('|')})` : '/features';
  const loggedRoutes = ['openapi', 'collections', ...(allCollections ? [allCollections] : [])].join('|');
  const journal = `
	log
	@loggedFeatures path_regexp ^${rootPattern}/(${loggedRoutes})$
	@unloggedFeatures not path_regexp ^${rootPattern}/(${loggedRoutes})$
	log_skip @unloggedFeatures
	log_append @loggedFeatures requestId {http.request.uuid}${allCollections ? `
	@loggedPublication path_regexp loggedPublication ^${rootPattern}/${allCollections}$
	log_append @loggedPublication publicationId {http.regexp.loggedPublication.1}` : ''}
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
  const managed = config.providers && managedGatewayRoutes(config, collectionRoute, featuresHtmlPolicy);
  const routes = managed ? `${accounts}\n${managed.routes}
	handle {
		header Cache-Control no-store
		respond 404
	}
` : `
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
		header X-Request-Id {http.request.uuid}${managed ? managed.fallback : publicAuthFallback}
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

function serviceName(config: FeaturesConfig, id: string) {
  return config.providers?.[id]?.image ? `provider-${id}` : 'pygeoapi';
}

function managedGatewayRoutes(config: FeaturesConfig, collectionRoute: (ids: string[]) => string, htmlPolicy: string) {
  const routes: string[] = [];
  const fallback: string[] = [];
  const publications = publicationEntries(config);
  const metadataFallback = config.auth && needsPublicMetadata(config);
  const byRoot = new Map<string, string[]>();
  for (const id of Object.keys(config.providers ?? {})) {
    const root = providerRoot(config, id);
    byRoot.set(root, [...(byRoot.get(root) ?? []), id]);
  }
  if (!byRoot.size) byRoot.set('/features', []);
  for (const [root, ids] of byRoot) {
    const rootIndex = routes.length;
    const entries = publications.filter(([, publication]) => ids.includes(publication.provider));
    const metadata = config.auth ? 'access' : 'metadata';
    routes.push(`
	@metadata${rootIndex} {
		method GET HEAD
		path ${root}/collections ${root}/openapi
	}
	handle @metadata${rootIndex} {
		route {${metadataFallback ? '\n			vars public_metadata true' : ''}
			reverse_proxy ${metadata}:3000 {
				header_up X-GIS-Request-Id {http.request.uuid}
			}
		}
	}
`);
    for (const id of ids) {
      const instance = config.providers?.[id];
      const api = instance?.image ? instance.api : undefined;
      const proxy = `uri strip_prefix ${root}
			${api && api.base_path !== '/' ? `rewrite * ${api.base_path}{http.request.uri.path}` : ''}
			reverse_proxy ${serviceName(config, id)}:${api?.port ?? 80} {
				header_up -Cookie
				header_up -Authorization
				header_down Cache-Control no-store${htmlPolicy}
			}`;
      if (id === ids[0]) {
        routes.push(`
	@root${rootIndex} {
		method GET HEAD
		path ${root} ${root}/ ${root}/conformance ${root}/static/*
	}
	handle @root${rootIndex} {
		route {
			${proxy}
		}
	}
`);
      }
      for (const mode of ['public', 'protected']) {
        const collectionIds = entries.filter(([, entry]) =>
          entry.provider === id && (entry.access === 'public') === (mode === 'public')).map(([key]) => key);
        if (!collectionIds.length) continue;
        const name = `provider${routes.length}`;
        const anonymous = mode === 'public';
        routes.push(`
	@${name} {
		method GET HEAD
		path_regexp ${name} ^${root}/${collectionRoute(collectionIds)}$
	}
	handle @${name} {
		route {${config.auth ? `${anonymous ? `\n			vars public_provider ${name}` : ''}
			forward_auth access:3000 {
				uri /internal/authorize/{http.regexp.${name}.1}
				header_up X-GIS-Request-Id {http.request.uuid}
			}${anonymous ? '\n			vars public_provider false' : ''}` : ''}
			${proxy}
		}
	}
`);
        if (config.auth && anonymous) fallback.push(`
		@${name}Unavailable vars public_provider ${name}
		handle @${name}Unavailable {
			route {
				${proxy}
			}
		}`);
      }
    }
  }
  if (metadataFallback) fallback.push(`
		@publicMetadataUnavailable vars public_metadata true
		handle @publicMetadataUnavailable {
			reverse_proxy metadata:3000
		}`);
  return { routes: routes.join('\n'), fallback: fallback.join('\n') };
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
  checkOpenApi(body, config.publicUrl, publicationEntries(config).map(([id]) => id));
  await writeFile(join(directory, 'openapi.json'), body);
}

export async function prepareFeaturesStack({ config, directory: revisionDirectory }: Revision,
  options: { previous?: Revision; sourceHash?: string | null; useArchivedOpenApi?: boolean } = {}) {
  const { previous, useArchivedOpenApi } = options;
  await mkdir(revisionDirectory, { recursive: true, mode: 0o700 });
  await rm(join(revisionDirectory, 'provider-directory'), { force: true });
  const sameSource = previous?.config.sourcePath === config.sourcePath;
  const hasPublications = config.publicationId !== null;
  const sourceHash = hasPublications ? await sourceFingerprint(config.sourcePath) : null;
  const previousHash = previous && await savedSourceFingerprint(previous.directory);
  if ((options.sourceHash && sourceHash && sourceHash !== options.sourceHash) ||
      (options.sourceHash === null && sameSource && sourceHash && previousHash && sourceHash !== previousHash)) {
    throw new Error('The GeoJSON source changed after planning.');
  }
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
      administratorEmails: auth.administrator_emails, managedFeatures: config.providers !== undefined,
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
  if (config.providers) {
    await reuseManagedArtifacts(config, revisionDirectory, previous,
      sameSource && (!sourceHash || sourceHash === previousHash) && (!options.sourceHash || options.sourceHash === previousHash));
    await writeProviderCompose(config, revisionDirectory);
  }
  await compose(config, revisionDirectory, 'config', '--quiet');
  await compose(config, revisionDirectory, 'run', '--rm', '--no-deps', '-T', '--entrypoint', 'caddy', 'caddy',
    'validate', '--config', '/etc/caddy/gis/Caddyfile', '--adapter', 'caddyfile');

  if (useArchivedOpenApi) {
    const archived = await readFile(join(revisionDirectory, 'openapi.json'), 'utf8').catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
    });
    if (archived) {
      checkOpenApi(archived, config.publicUrl, publicationEntries(config).map(([id]) => id));
      return;
    }
  }
  if (config.providers) {
    await prepareManagedFeatures(config, revisionDirectory, sourceHash,
      sourceHash ?? (sameSource ? previousHash : null));
    return;
  }
  if (previous && previousHash && sameSource && (!sourceHash || sourceHash === previousHash) &&
      (!options.sourceHash || options.sourceHash === previousHash) &&
      !providerConfigurationChanged(config, previous.config)) {
    await copyFile(join(previous.directory, 'openapi.json'), join(revisionDirectory, 'openapi.json'));
    const provider = await nativeProviderDirectory(previous.directory);
    await writeFile(join(revisionDirectory, 'provider-directory'), basename(provider));
    await writeFile(join(revisionDirectory, 'source.sha256'), previousHash);
    return;
  }
  if (hasPublications && !sourceHash) throw new Error('The GeoJSON source is unavailable.');
  const output = await compose(config, revisionDirectory, 'run', '--rm', '--no-deps', '-T', '--entrypoint', '/bin/sh', 'pygeoapi',
    '-ec', [
      ...(hasPublications ? [
        checkGeoJson,
      ] : []),
      generateOpenApi,
      'cat /tmp/openapi.json',
    ].join('\n'));
  checkOpenApi(output, config.publicUrl, publicationEntries(config).map(([id]) => id));
  await writeFile(join(revisionDirectory, 'openapi.json'), output);
  if (sourceHash) await writeFile(join(revisionDirectory, 'source.sha256'), sourceHash);
}

async function writeProviderCompose(config: FeaturesConfig, directory: string) {
  const services: Record<string, unknown> = {};
  const volumes: Record<string, object> = {};
  if (!builtInProviderId(config)) services.pygeoapi = { profiles: ['unused-built-in'] };
  if (needsPublicMetadata(config)) services.metadata = {
    build: { context: '.', dockerfile: 'Dockerfile.access' },
    command: ['node', 'dist/public-metadata.js'],
    restart: 'unless-stopped',
    volumes: [{ type: 'bind', source: '${GIS_REVISION_DIR}', target: '/etc/gis', read_only: true }],
  };
  const escapeCompose = (value: string) => value.replaceAll('$', () => '$$');
  for (const [id, provider] of Object.entries(config.providers ?? {})) {
    if (!provider.image) continue;
    const service = serviceName(config, id);
    const native = join(directory, service);
    const { port, scheme, base_path: base, readiness } = provider.api;
    await mkdir(native, { recursive: true });
    await writeFile(join(native, 'pygeoapi.yml'), JSON.stringify(pygeoapiConfig(config, id)));
    const namedVolumes = Object.entries(provider.volumes ?? {}).map(([name, target]) => {
      const volume = `${service}_${name}`;
      volumes[volume] = {};
      return { type: 'volume', source: volume, target };
    });
    services[service] = {
      image: pinnedImage(provider),
      restart: 'unless-stopped',
      environment: {
        ...Object.fromEntries(Object.entries(provider.environment ?? {}).map(([name, value]) => [name, escapeCompose(value)])),
        PYGEOAPI_CONFIG: '/etc/pygeoapi/gis/pygeoapi.yml',
        PYGEOAPI_OPENAPI: '/etc/pygeoapi/gis/openapi.json',
        ...(base !== '/' && { SCRIPT_NAME: base }),
      },
      entrypoint: ['/venv/bin/gunicorn'],
      command: ['--workers', '1', '--worker-class', 'gevent', '--timeout', '6000',
        '--bind', `0.0.0.0:${port}`, 'pygeoapi.flask_app:APP'],
      volumes: [
        { type: 'bind', source: escapeCompose(await nativeProviderDirectory(directory, service)), target: '/etc/pygeoapi/gis', read_only: true,
          bind: { create_host_path: false } },
        ...(publicationEntries(config).some(([, publication]) => publication.provider === id)
          ? [{ type: 'bind', source: '${GIS_SOURCE_FILE}', target: '/source/data.geojson', read_only: true,
            bind: { create_host_path: false } }] : []),
        ...namedVolumes,
      ],
      healthcheck: {
        test: ['CMD', '/venv/bin/python', '-c',
          `from urllib.request import urlopen; urlopen('${scheme}://127.0.0.1:${port}${base === '/' ? '' : base}${readiness}', timeout=2).read()`],
        interval: '2s', timeout: '3s', retries: 25,
      },
    };
  }
  await writeFile(join(directory, 'compose.providers.json'), JSON.stringify({ services, volumes }));
}

const checkGeoJson = `/venv/bin/python -c "from pygeoapi.provider.geojson import GeoJSONProvider; GeoJSONProvider({'name': 'GeoJSON', 'type': 'feature', 'data': '/source/data.geojson', 'id_field': 'id'}).query(limit=1)" >/dev/null`;
const generateOpenApi = '/venv/bin/pygeoapi openapi generate "$PYGEOAPI_CONFIG" -f json -of /tmp/openapi.json >/dev/null';

async function reuseManagedArtifacts(config: FeaturesConfig, directory: string, previous: Revision | undefined,
  sameSourceContent: boolean) {
  for (const [id, provider] of Object.entries(config.providers ?? {})) {
    const service = serviceName(config, id);
    const draft = service === 'pygeoapi' ? directory : join(directory, service);
    await mkdir(draft, { recursive: true });
    await rm(join(draft, 'provider-directory'), { force: true });
    if (!previous || !sameSourceContent || providerConfigurationChanged(config, previous.config, id)) continue;
    const prior = previous.config.providers?.[id];
    const exists = provider.image ? prior?.image && JSON.stringify(prior) === JSON.stringify(provider)
      : id === builtInProviderId(previous.config);
    if (!exists) continue;
    const native = await nativeProviderDirectory(previous.directory, service);
    const version = basename(service === 'pygeoapi' ? native : join(native, '..'));
    await writeFile(join(draft, 'provider-directory'), version);
  }
}

async function prepareManagedFeatures(config: FeaturesConfig, directory: string, sourceHash: string | null,
  savedHash?: string | null) {
  const documents: Record<string, { url: string; api: FeaturesOpenApi }> = {};
  const providers = Object.keys(config.providers ?? {});
  const entries = publicationEntries(config);
  for (const id of providers) {
    const root = providerRoot(config, id);
    const url = new URL(root, config.publicUrl).href;
    const service = serviceName(config, id);
    const collectionIds = entries.filter(([, pub]) => pub.provider === id).map(([key]) => key);
    const native = service === 'pygeoapi' ? directory : join(directory, service);
    const mounted = await nativeProviderDirectory(directory, service);
    let api: FeaturesOpenApi;
    if (mounted !== native) {
      api = checkOpenApi(await readFile(join(mounted, 'openapi.json'), 'utf8'), url, collectionIds);
    } else {
      if (collectionIds.length && !sourceHash) throw new Error('The GeoJSON source is unavailable.');
      const output = await compose(config, directory, 'run', '--rm', '--no-deps', '-T', '--entrypoint', '/bin/sh', service,
        '-ec', [...(collectionIds.length ? [checkGeoJson] : []), generateOpenApi, 'cat /tmp/openapi.json'].join('\n'));
      api = checkOpenApi(output, url, collectionIds);
    }
    await writeFile(join(native, 'openapi.json'), JSON.stringify(api));
    const shared = documents[root];
    if (shared) {
      Object.assign(shared.api.paths!, Object.fromEntries(Object.entries(api.paths ?? {}).filter(([key]) =>
        key.startsWith('/collections/'))));
      shared.api.tags = [...(shared.api.tags ?? []), ...(api.tags ?? []).filter(({ name }) => name !== 'server')];
    } else {
      documents[root] = { url, api };
    }
  }
  if (!providers.length) {
    documents['/features'] = { url: config.publicUrl, api: {
      openapi: '3.0.2', servers: [{ url: config.publicUrl }], info: { title: 'GIS Platform Features', version: '1' },
      components: {}, paths: {},
    } };
  }
  const roots = Object.fromEntries(Object.entries(documents).map(([root, { url, api }]) => [
    root, { url, api, collections: entries.filter(([, publication]) => providerRoot(config, publication.provider) === root)
      .map(([id, { title, description, extent }]) => ({
        id, title, description, extent: { spatial: { bbox: [extent], crs: 'http://www.opengis.net/def/crs/OGC/1.3/CRS84' } },
        links: ['json', 'html', 'jsonld'].map((format) => ({
          rel: 'self', href: `${url}/collections/${id}?f=${format}`,
          type: ({ json: 'application/json', html: 'text/html', jsonld: 'application/ld+json' })[format],
        })).concat([{ rel: 'items', href: `${url}/collections/${id}/items?f=json`, type: 'application/geo+json' }]),
      })) },
  ]));
  await writeFile(join(directory, 'features.json'), JSON.stringify(roots));
  if (savedHash) await writeFile(join(directory, 'source.sha256'), savedHash);
}

async function nativeProviderDirectory(directory: string, service = 'pygeoapi') {
  const native = service === 'pygeoapi' ? directory : join(directory, service);
  const revision = await readFile(join(native, 'provider-directory'), 'utf8').catch(() => undefined);
  if (!revision || !/^plan-[a-f0-9]{64}$/.test(revision)) return native;
  return service === 'pygeoapi' ? join(directory, '..', revision) : join(directory, '..', revision, service);
}

export async function compose(config: FeaturesConfig, revisionDirectory: string, ...args: string[]) {
  const files = [composeFile('compose.yaml')];
  if (config.publicationId === null) files.push(composeFile('compose.empty.yaml'));
  if (config.tls) files.push(composeFile('compose.tls.yaml'));
  if (config.auth) {
    files.push(composeFile('compose.auth.yaml'));
    if (config.auth.mode === 'development') files.push(composeFile('compose.mailpit.yaml'));
    else if (config.auth.smtp.password_file) files.push(join(revisionDirectory, 'compose.smtp.json'));
    if (config.auth.cli) files.push(join(revisionDirectory, 'compose.admin.json'));
  }
  if (config.providers) files.push(join(revisionDirectory, 'compose.providers.json'));
  const { stdout } = await run('docker', ['compose', ...(project ? ['-p', project] : []),
    ...files.flatMap((file) => ['-f', file]), ...args], {
    env: {
      ...process.env,
      GIS_PUBLIC_PORT: String(config.port),
      GIS_CADDY_PORT: config.tls ? '443' : '80',
      GIS_TLS_CERT_FILE: config.tls?.cert_file,
      GIS_TLS_KEY_FILE: config.tls?.key_file,
      GIS_REVISION_DIR: revisionDirectory,
      GIS_PROVIDER_REVISION_DIR: await nativeProviderDirectory(revisionDirectory),
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
      agent: false,
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

interface FeaturesOpenApi {
  openapi?: string;
  servers?: { url: string }[];
  paths?: Record<string, unknown>;
  tags?: { name: string }[];
  info?: { title: string; version: string };
  components?: object;
}

function checkOpenApi(body: string, publicUrl: string, ids: string[]) {
  const api = JSON.parse(body) as FeaturesOpenApi;
  if (!api.openapi?.startsWith('3.0.') || api.servers?.[0]?.url !== publicUrl || !api.paths ||
      ids.some((id) => !api.paths?.[`/collections/${id}/items`])) {
    throw new Error('The generated Features OpenAPI does not match the configuration.');
  }
  return api;
}

export async function closeGateway(directory: string) {
  await writeFile(join(directory, 'closed'), '');
}

export async function openGateway(directory: string) {
  await rm(join(directory, 'closed'), { force: true });
}

export async function publicationGrantRemoval({ config, directory }: Revision, planId: string,
  action: 'abort' | { deleteIds: string[] }) {
  if (!/^plan-[a-f0-9]{64}$/.test(planId) ||
      (action !== 'abort' && action.deleteIds.some((id) => !/^[a-z][a-z0-9-]{0,62}$/.test(id)))) {
    throw new Error('Invalid publication removal.');
  }
  const version = `'${planId}'`;
  // The first transaction decides the outcome. A delayed worker cannot delete
  // grants if recovery has already recorded an aborted removal.
  const command = action === 'abort'
    ? `INSERT INTO publication_grant_removal (version, committed) VALUES (${version}, false) ON CONFLICT DO NOTHING;`
    : `
      DO $grant_removal$
      BEGIN
        INSERT INTO publication_grant_removal (version, committed) VALUES (${version}, true) ON CONFLICT DO NOTHING;
        IF FOUND AND to_regclass('public.publication_grant') IS NOT NULL THEN
          DELETE FROM public.publication_grant
            WHERE publication_id IN (${action.deleteIds.map((id) => `'${id}'`).join(', ')});
        END IF;
      END
      $grant_removal$;
    `;
  const output = await compose(config, directory, 'exec', '-T', 'postgres',
    'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-U', 'gis', '-d', 'gis', '-c', `
      BEGIN;
      SELECT pg_advisory_xact_lock(hashtext('gis.publication_grant_removal'));
      CREATE TABLE IF NOT EXISTS publication_grant_removal (version text PRIMARY KEY, committed boolean NOT NULL);
      ${command}
      SELECT committed FROM publication_grant_removal WHERE version = ${version};
      COMMIT;
    `);
  const committed = output.trim();
  if (committed !== 't' && committed !== 'f') throw new Error('The grant removal result is unavailable.');
  return committed === 't';
}

function stackServices(config: FeaturesConfig) {
  const providers = [
    ...(builtInProviderId(config) ? ['pygeoapi'] : []),
    ...Object.entries(config.providers ?? {}).filter(([, provider]) => provider.image).map(([id]) => serviceName(config, id)),
  ];
  return [...providers, ...(config.auth ? ['access', 'postgres', ...(config.auth.mode === 'development' ? ['mailpit'] : [])] : []),
    ...(needsPublicMetadata(config) ? ['metadata'] : [])];
}

export async function featuresStackRunning(config: FeaturesConfig, directory: string) {
  const running = (await compose(config, directory, 'ps', '--status', 'running', '--services')).trim().split(/\s+/);
  return ['caddy', ...stackServices(config)].every((service) => running.includes(service));
}

export async function startFeaturesStack(config: FeaturesConfig, revisionDirectory: string) {
  const origin = new URL(config.publicUrl);
  const certificate = config.tls ? await readFile(config.tls.cert_file) : undefined;
  await compose(config, revisionDirectory, 'up', '-d', '--no-deps', 'caddy');
  if (!builtInProviderId(config)) await compose(config, revisionDirectory, 'rm', '-sf', 'pygeoapi');
  await compose(config, revisionDirectory, 'up', '-d', '--remove-orphans',
    '--wait', '--wait-timeout', '65', ...(config.auth || config.providers ? ['--build'] : []), ...stackServices(config));

  const collections = publicationEntries(config).map(([id, publication]) => ({
    id, ...publication, url: publicationUrl(config, id, publication),
  }));
  const internal = async (path: string, status: number, base = 'http://127.0.0.1:2080') => {
    try {
      const body = await compose(config, revisionDirectory, 'exec', '-T', 'caddy', 'wget', '-T', '3', '-S', '-O', '-',
        `${base}${path}`);
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
      for (const { id, provider, access, url } of collections) {
        const path = new URL(url).pathname + '?f=json';
        let body = await internal(path, access === 'public' ? 200 : 401);
        if (config.providers && access !== 'public') {
          const instance = config.providers[provider];
          const api = instance?.image ? instance.api : undefined;
          const base = api?.base_path === '/' ? '' : api?.base_path ?? '';
          body = await internal(`${base}/collections/${id}?f=json`, 200,
            `http://${serviceName(config, provider)}:${api?.port ?? 80}`);
        }
        if (body) {
          const collection = JSON.parse(body) as { id?: string; links?: { rel: string; href: string }[] };
          if (collection.id !== id || !collection.links?.some(({ rel, href }) =>
            rel === 'items' && href === `${url}/items?f=json`)) {
            throw new Error('Unexpected Features collection or canonical URL.');
          }
        }
      }
      const roots = new Set(Object.keys(config.providers ?? {}).map((id) => providerRoot(config, id)));
      if (!roots.size) roots.add('/features');
      for (const root of roots) {
        const visible = collections.filter(({ access, provider }) =>
          access === 'public' && providerRoot(config, provider) === root).map(({ id }) => id);
        const api = checkOpenApi(await internal(`${root}/openapi?f=json`, 200), new URL(root, origin).href, visible);
        if (config.providers) {
          const catalog = JSON.parse(await internal(`${root}/collections?f=json`, 200)) as { collections: { id: string }[] };
          for (const { id, access, provider } of collections) {
            if (providerRoot(config, provider) === root &&
                (catalog.collections.some((item) => item.id === id) !== (access === 'public') ||
                 Boolean(api.paths?.[`/collections/${id}/items`]) !== (access === 'public'))) {
              throw new Error('The candidate metadata does not match the publication access rules.');
            }
          }
        }
      }
      return;
    } catch (error) {
      if (attempt === 14) throw error;
    }
    await setTimeout(500);
  }
}
