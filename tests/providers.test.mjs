import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createServer } from 'node:net';
import { test } from 'node:test';
import { setTimeout } from 'node:timers/promises';
import { promisify } from 'node:util';
import { parse, stringify } from 'yaml';

const run = promisify(execFile);
const file = process.env.GIS_TEST_CONFIG;
const gateway = process.env.GIS_TEST_PUBLIC_URL;
const project = process.env.COMPOSE_PROJECT_NAME;
const base = 'geopython/pygeoapi:0.24.0@sha256:a62895f2585ef1fcd1fc97ec35bf13177becc1334a622172a2c5c4d2145b8f0a';
const registryImage = 'registry:3@sha256:82f6ff4a7f982960c8aa51617fea3aabc485df6e55cce80d22deb1de36f1bc3c';

async function cli(...args) {
  const result = await run(process.execPath, ['dist/cli.js', ...args, '--json'], { windowsHide: true })
    .catch((error) => {
      if (typeof error.code !== 'number') throw error;
      return { ...error, exitCode: error.code };
    });
  return { ...JSON.parse(result.stdout), exitCode: result.exitCode ?? 0 };
}

async function docker(...args) {
  return (await run('docker', args, { windowsHide: true })).stdout.trim();
}

async function get(path, expected = 200) {
  const res = await fetch(gateway + path, { headers: { Connection: 'close' }, signal: AbortSignal.timeout(5000) });
  assert.equal(res.status, expected, path);
  return res;
}

async function integrationFile(name, api = {}, volumes = { cache: '/provider-cache' }) {
  const integration = join(dirname(file), `${name}.yaml`);
  await writeFile(integration, stringify({
    type: 'pygeoapi', api: { protocol: 'features', scheme: 'http', port: 8081, base_path: '/',
      public_root: '/features', links: 'canonical', readiness: '/openapi?f=json', ...api },
    volumes,
  }));
  return integration;
}

async function service(id) {
  const container = await docker('ps', '-aq', '--filter', `label=com.docker.compose.project=${project}`,
    '--filter', `label=com.docker.compose.service=provider-${id}`);
  if (!container) return null;
  const [details] = JSON.parse(await docker('inspect', container));
  return details;
}

async function applyConfig(config) {
  await writeFile(file, stringify(config));
  const plan = await cli('config', 'plan', file);
  assert.equal(plan.code, 'OK', plan.data.message);
  const applied = await cli('config', 'apply', plan.data.planId);
  assert.equal(applied.code, 'OK', applied.data.message);
  return plan.data;
}

test('explicit provider prefixes move only their own publications off a shared flat root', async (t) => {
  const original = await readFile(file, 'utf8');
  t.after(() => writeFile(file, original));
  const config = parse(original);
  const previous = await cli('status');
  assert.equal(previous.code, 'OK', previous.data.message);
  const legacy = config.publications.places;
  config.providers['provider-pygeoapi'] = { type: 'pygeoapi', image: base,
    api: { protocols: ['features', 'maps', 'tiles'], public_prefix: 'pygeoapi', scheme: 'http',
      port: 80, base_path: '/', links: 'canonical', readiness: '/openapi' } };
  config.providers['provider-pygeoapi-archive'] = { type: 'pygeoapi', image: base,
    api: { ...config.providers['provider-pygeoapi'].api, protocols: ['features'] } };
  delete config.providers['provider-pygeoapi-archive'].api.public_prefix;
  config.publications.places = { ...legacy, provider: 'provider-pygeoapi' };
  config.publications['other-places'] = legacy;
  config.publications['archive-places'] = { ...legacy, provider: 'provider-pygeoapi-archive' };
  const plan = await applyConfig(config);
  const moved = plan.publications.find(({ publicationId }) => publicationId === 'places');
  assert.equal(moved.previousUrl, gateway + '/features/collections/places');
  assert.equal(moved.newUrl, gateway + '/pygeoapi/features/collections/places');
  assert.equal(moved.personalGrants, 'preserve');
  const [instance] = JSON.parse(await docker('inspect', `${project}-provider-pygeoapi-1`));
  assert.ok(instance.State.Running);
  assert.deepEqual(instance.HostConfig.PortBindings ?? {}, {});
  const data = await (await get('/pygeoapi/features/collections/places/items?f=json&limit=1')).json();
  assert.equal(data.features.length, 1);
  const next = data.links.find(({ rel }) => rel === 'next').href;
  assert.equal(next.startsWith(gateway + '/pygeoapi/features/collections/places/items?'), true);
  assert.equal((await (await get(next.slice(gateway.length))).json()).features.length, 1);
  await get('/provider-pygeoapi-archive/features/collections/archive-places/items?f=json');
  await get('/features/collections/other-places/items?f=json');
  await get('/features/collections/places/items?f=json', 404);
  await get('/pygeoapi/maps/collections/places/items?f=json', 404);
  await get('/provider-pygeoapi-archive/features/collections/places/items?f=json', 404);
  for (const [root, ids] of [['/pygeoapi/features', ['places']], ['/pygeoapi/maps', []],
    ['/pygeoapi/tiles', []], ['/features', ['other-places']]]) {
    const catalog = await (await get(`${root}/collections?f=json`)).json();
    assert.deepEqual(catalog.collections.map(({ id }) => id), ids);
    const openapi = await (await get(`${root}/openapi?f=json`)).json();
    assert.equal(openapi.servers[0].url, gateway + root);
    assert.equal(Boolean(openapi.paths['/collections/places/items']), ids.includes('places'));
    await get(`${root}/conformance?f=json`);
  }

  const rollback = await cli('config', 'plan', '--rollback-to', previous.data.currentVersion);
  assert.equal(rollback.code, 'OK', rollback.data.message);
  const restored = await cli('config', 'apply', rollback.data.planId);
  assert.equal(restored.code, 'OK', restored.data.message);
  await get('/features/collections/places/items?f=json');
  await get('/pygeoapi/features/collections/places/items?f=json', 404);
});

test('adding a provider persists its Compose service and serves Features through Caddy', async () => {
  const integration = await integrationFile('provider', {}, { 'cache-data': '/provider-cache' });
  const added = await cli('provider', 'add', 'extra', base, integration, file);
  assert.equal(added.code, 'OK', added.data.message);
  assert.equal(parse(await readFile(file, 'utf8')).providers.extra.image, base);
  const details = await service('extra');
  assert.ok(details?.State.Running);
  assert.equal(details.Config.Image, base);
  assert.deepEqual(details.HostConfig.PortBindings ?? {}, {});
  const separate = await integrationFile('separate-provider', {}, { data: '/provider-cache' });
  const second = await cli('provider', 'add', 'extra-cache', base, separate, file);
  assert.equal(second.code, 'OK', second.data.message);
  const other = await service('extra-cache');
  const cache = (container) => container.Mounts.find(({ Destination }) => Destination === '/provider-cache').Name;
  assert.notEqual(cache(details), cache(other));

  const config = parse(await readFile(file, 'utf8'));
  config.publications.extra = { ...config.publications.places, provider: 'extra' };
  await applyConfig(config);
  const collection = await (await get('/features/collections/extra?f=json')).json();
  assert.equal(collection.id, 'extra');
  assert.ok(collection.links.some(({ href }) => href === gateway + '/features/collections/extra/items?f=json'));
  assert.equal((await (await get('/features/collections/extra/items?f=json')).json()).features.length, 3);
  const catalog = await (await get('/features/collections?f=json')).json();
  assert.deepEqual(catalog.collections.map(({ id }) => id).sort(), ['extra', 'places']);
  const api = await (await get('/features/openapi?f=json')).json();
  assert.ok(api.paths['/collections/extra/items']);
  assert.ok(api.paths['/collections/places/items']);
  await get('/features/admin', 404);
});

test('provider validation rejects unknown instances, unsupported APIs, and overlapping public roots', async () => {
  const original = await readFile(file, 'utf8');
  const config = parse(original);
  const invalid = join(dirname(file), 'invalid-provider.yaml');
  const publication = config.publications.places;
  const managed = { ...parse(await readFile(await integrationFile('validation'), 'utf8')), image: base };
  const validate = async (draft, message) => {
    await writeFile(invalid, stringify(draft));
    const result = await cli('config', 'validate', invalid);
    assert.equal(result.code, 'INVALID_CONFIG');
    assert.match(result.data.message, message);
  };
  await validate({ ...config, publications: { places: { ...publication, provider: 'unknown' } } }, /unknown provider/);
  await validate({ ...config, publications: { places: { ...publication, protocol: 'tiles' } } }, /protocol/);
  await validate({ ...config, providers: { ...config.providers,
    nested: { ...managed, api: { ...managed.api, public_root: '/features/collections' } } } }, /Ambiguous public root/);

  const { protocol, public_root, ...http } = managed.api;
  const nested = { ...managed, api: { ...http, protocols: ['features', 'maps'], public_prefix: 'pygeoapi' } };
  for (const [changes, message] of [
    [{ protocols: [] }, /protocols.*fewer than 1/],
    [{ protocols: ['features', 'features'] }, /protocols.*duplicate/],
    [{ protocols: ['mvt'] }, /unsupported by its pygeoapi adapter/],
    [{ protocol, public_root }, /must match exactly one schema/],
    [{ public_prefix: 'account' }, /reserved public prefix/],
  ]) await validate({ ...config, providers: { ...config.providers, nested: { ...nested, api: { ...nested.api, ...changes } } } }, message);
  await validate({ ...config, publications: { places: { ...publication, provider: 'nested', protocol: 'tiles' } },
    providers: { ...config.providers, nested } }, /protocol unsupported by provider 'nested'/);
  await validate({ ...config, providers: { ...config.providers, nested, pygeoapi: { ...nested,
    api: { ...http, protocols: ['tiles'] } } } }, /Duplicate public prefix/);
  await validate({ ...config, providers: { ...config.providers, nested,
    legacy: { ...managed, api: { ...managed.api, public_root: '/pygeoapi/old' } } } }, /overlaps an instance prefix/);
});

async function createRegistry(t) {
  const listener = createServer();
  await new Promise((resolve, reject) => listener.once('error', reject).listen(0, '127.0.0.1', resolve));
  const { port } = listener.address();
  await new Promise((resolve) => listener.close(resolve));
  const name = `${project}-registry`;
  await docker('run', '-d', '--rm', '--name', name, '-p', `127.0.0.1:${port}:5000`, registryImage);
  t.after(async () => { await docker('stop', name); });
  const host = `127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 25; attempt++) {
    const response = await fetch(`http://${host}/v2/`, { signal: AbortSignal.timeout(1000) }).catch(() => null);
    if (response?.ok) return host;
    await setTimeout(200);
  }
  throw new Error('Test image registry did not start.');
}

async function pushImage(registry, version, label, invalid = false) {
  const context = await mkdtemp(join(dirname(file), 'provider-image-'));
  const reference = `${registry}/features:${version}`;
  await writeFile(join(context, 'Dockerfile'), `FROM ${base}\nLABEL test.revision=${label}\n` +
    (invalid ? 'RUN mv /venv/bin/gunicorn /venv/bin/gunicorn.disabled\n' : ''));
  await docker('build', '-t', reference, context);
  const output = await docker('push', reference);
  const digest = /digest: (sha256:[0-9a-f]{64})/i.exec(output)?.[1];
  assert.ok(digest, output);
  return { reference, digest, pinned: `${registry}/features@${digest}` };
}

test('updating a provider pulls both a new tag and a new digest under one tag, then restores a failed switch', async (t) => {
  const registry = await createRegistry(t);
  const first = await pushImage(registry, 'v1', 'initial');
  const integration = await integrationFile('update', { public_root: '/new-features', base_path: '/engine' });
  const added = await cli('provider', 'add', 'updatable', first.reference, integration, file);
  assert.equal(added.code, 'OK', added.data.message);
  let config = parse(await readFile(file, 'utf8'));
  assert.equal(config.providers.updatable.digest, first.digest);
  config.publications.places.provider = 'updatable';
  const moved = await applyConfig(config);
  assert.deepEqual(moved.publications.find(({ publicationId }) => publicationId === 'places'), {
    publicationId: 'places', previousUrl: `${gateway}/features/collections/places`,
    newUrl: `${gateway}/new-features/collections/places`, previousAccess: 'public',
    newAccess: 'public', personalGrants: 'preserve',
  });
  await get('/features/collections/places/items?f=json', 404);
  const path = '/new-features/collections/places/items?f=json';
  assert.equal((await (await get(path)).json()).features.length, 3);
  const firstDetails = await service('updatable');
  assert.equal(firstDetails.Config.Image, first.pinned);
  const volume = firstDetails.Mounts.find(({ Destination }) => Destination === '/provider-cache').Name;
  await docker('exec', firstDetails.Id, '/bin/sh', '-ec', 'printf kept > /provider-cache/test-marker');
  const configBeforeUpdates = parse(await readFile(file, 'utf8'));
  const blocked = await cli('provider', 'remove', 'updatable', file);
  assert.equal(blocked.code, 'INVALID_CONFIG');
  assert.deepEqual(blocked.data.publicationIds, ['places']);
  assert.equal((await service('updatable')).Id, firstDetails.Id);

  const second = await pushImage(registry, 'v2', 'new-tag');
  await writeFile(file, stringify({ ...configBeforeUpdates,
    publications: { ...configBeforeUpdates.publications, places: { ...configBeforeUpdates.publications.places, title: 'Draft title' } },
  }));
  const pending = await cli('provider', 'update', 'updatable', file, second.reference);
  assert.equal(pending.code, 'INVALID_CONFIG');
  assert.equal((await service('updatable')).Id, firstDetails.Id);
  await writeFile(file, stringify(configBeforeUpdates));
  const updated = await cli('provider', 'update', 'updatable', file, second.reference);
  assert.equal(updated.code, 'OK', updated.data.message);
  assert.equal((await service('updatable')).Config.Image, second.pinned);
  const third = await pushImage(registry, 'v2', 'same-tag');
  assert.notEqual(third.digest, second.digest);
  const refreshed = await cli('provider', 'update', 'updatable', file);
  assert.equal(refreshed.code, 'OK', refreshed.data.message);
  const thirdDetails = await service('updatable');
  assert.equal(thirdDetails.Config.Image, third.pinned);
  assert.notEqual(thirdDetails.Id, firstDetails.Id);
  assert.equal(await docker('exec', thirdDetails.Id, 'cat', '/provider-cache/test-marker'), 'kept');
  config = parse(await readFile(file, 'utf8'));
  assert.deepEqual(config.publications, configBeforeUpdates.publications);
  assert.deepEqual(config.providers.updatable, { ...configBeforeUpdates.providers.updatable, image: third.reference, digest: third.digest });
  const pinnedYaml = await readFile(file, 'utf8');
  await get(path);

  const broken = await pushImage(registry, 'v2', 'broken', true);
  assert.notEqual(broken.digest, third.digest);
  const failed = await cli('provider', 'update', 'updatable', file);
  assert.equal(failed.code, 'APPLY_FAILED', failed.data.message);
  assert.equal(failed.data.currentVersion, refreshed.data.currentVersion);
  assert.equal(await readFile(file, 'utf8'), pinnedYaml);
  assert.equal((await service('updatable')).Config.Image, third.pinned);
  await get(path);
  const candidate = await cli('config', 'plan', file);
  assert.equal(candidate.code, 'OK');
  assert.deepEqual(candidate.data.services, []);

  await docker('compose', '-p', project, 'down', '--remove-orphans');
  assert.equal(await service('updatable'), null);
  const restarted = await cli('config', 'apply', candidate.data.planId);
  assert.equal(restarted.code, 'OK', restarted.data.message);
  assert.equal((await service('updatable')).Config.Image, third.pinned);
  assert.equal(await docker('exec', (await service('updatable')).Id, 'cat', '/provider-cache/test-marker'), 'kept');
  await get(path);

  const rolledBack = await cli('config', 'plan', '--rollback-to', moved.planId);
  assert.equal(rolledBack.code, 'OK', rolledBack.data.message);
  const applied = await cli('config', 'apply', rolledBack.data.planId);
  assert.equal(applied.code, 'OK', applied.data.message);
  const restored = await service('updatable');
  assert.equal(restored.Config.Image, first.pinned);
  assert.equal(await docker('exec', restored.Id, 'cat', '/provider-cache/test-marker'), 'kept');
  await get(path);
  await docker('restart', restored.Id);
  for (let attempt = 0; attempt < 25; attempt++) {
    if ((await service('updatable')).State.Health.Status === 'healthy') break;
    await setTimeout(300);
  }
  assert.equal((await service('updatable')).Config.Image, first.pinned);
  await get(path);

  config.publications.places.provider = 'file-features';
  await applyConfig(config);
  const removed = await cli('provider', 'remove', 'updatable', file);
  assert.equal(removed.code, 'OK', removed.data.message);
  assert.equal(await service('updatable'), null);
  assert.equal(parse(await readFile(file, 'utf8')).providers.updatable, undefined);
  assert.ok(await docker('volume', 'inspect', volume));
  await get('/features/collections/places/items?f=json');
  await get(path, 404);
});
