import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { test } from 'node:test';
import { auth, register, request, session, signIn } from './access-client.mjs';

const gateway = process.env.GIS_TEST_PUBLIC_URL;
const privateCollection = '/features/collections/private-places';
const items = `${privateCollection}/items/central?f=json`;
const publicItems = '/features/collections/places/items/central?f=json';
const password = 'private-password-16';

function cli(args, expected = 'OK', exitCode = 0, environment = {}) {
  const result = spawnSync(process.execPath, ['dist/cli.js', ...args, '--json'], {
    env: { ...process.env, ...environment }, encoding: 'utf8', timeout: 15_000, windowsHide: true,
  });
  assert.ifError(result.error);
  const response = JSON.parse(result.stdout);
  assert.equal(response.code, expected, result.stdout);
  assert.equal(response.status, exitCode === 0 ? 'ok' : 'error');
  assert.equal(result.status, exitCode, result.stderr);
  return response.data;
}

function dockerJson(...args) {
  const result = spawnSync('docker', args, { encoding: 'utf8', timeout: 60_000, windowsHide: true });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}

function compose(...args) {
  const revision = process.env.GIS_REVISION_DIR;
  return dockerJson('compose', '-f', 'compose.yaml', '-f', 'compose.auth.yaml', '-f', 'compose.mailpit.yaml',
    '-f', join(revision, 'compose.admin.json'), ...args);
}

function operator(name) {
  return {
    GIS_ADMIN_CERT_FILE: join(process.env.GIS_TEST_RESULTS, `${name}.pem`),
    GIS_ADMIN_KEY_FILE: join(process.env.GIS_TEST_RESULTS, `${name}-key.pem`),
  };
}

function publications(user) {
  return user.publications.map(({ id }) => id);
}

test('anonymous visitors receive 401 for a private publication and cannot see it in shared descriptions', async () => {
  const items = await fetch(`${gateway}${privateCollection}/items?f=json`);
  assert.equal(items.status, 401);
  assert.match(items.headers.get('www-authenticate'), /^Session\b/);
  assert.equal(items.headers.get('cache-control'), 'no-store');
  assert.equal((await items.json()).code, 'Unauthorized');

  const catalog = await fetch(`${gateway}/features/collections?f=json`);
  assert.equal(catalog.status, 200);
  assert.deepEqual((await catalog.json()).collections.map(({ id }) => id), ['places']);
  const openapi = await fetch(`${gateway}/features/openapi?f=json`);
  assert.equal(openapi.status, 200);
  assert.doesNotMatch(await openapi.text(), /private-places|other-private/);
});

test('personal grants and revocations apply to the next request for exactly one publication', async () => {
  const email = '-grantee@example.test';
  await register(email, password, 'Grant reader');
  const cookie = await signIn(email, password);
  const options = { headers: { Cookie: cookie } };
  const other = '/features/collections/other-private/items/central?f=json';
  assert.equal((await request(items, options)).status, 403);
  const grant = cli(['access', 'grant', 'private-places', '--email', '-GRANTEE@EXAMPLE.TEST']);
  assert.ok(grant.userId);
  assert.equal(grant.publicationId, 'private-places');
  cli(['access', 'grant', 'private-places', '--user-id', grant.userId], 'NO_CHANGE');
  const response = await request(items, options);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).id, 'central');
  assert.equal((await request(other, options)).status, 403);
  const detail = await request(`${privateCollection}?f=json`, options);
  assert.equal(detail.status, 200);
  const linked = new URL((await detail.json()).links.find(({ rel, type }) => rel === 'items' && type === 'application/geo+json').href);
  assert.equal(linked.origin, gateway);
  linked.searchParams.set('limit', '1');
  const page = await request(linked, options);
  assert.equal(page.status, 200);
  const next = (await page.json()).links.find(({ rel }) => rel === 'next').href;
  assert.equal((await request(next, options)).status, 200);

  const catalog = await request('/features/collections', { headers: { Cookie: cookie, Accept: 'application/ld+json' } });
  assert.deepEqual((await catalog.json()).dataset.map((entry) => new URL(entry['@id']).pathname), [
    '/features/collections/registered-places', '/features/collections/places', privateCollection,
  ]);
  const api = await request('/features/openapi?f=json', options);
  const openapi = await api.json();
  const operation = openapi.paths['/collections/private-places/items'].get;
  assert.deepEqual(operation.security, [{ session: [] }]);
  assert.ok(operation.responses['401'].headers['WWW-Authenticate']);
  assert.ok(operation.responses['403']);
  assert.ok(operation.responses['503']);
  assert.doesNotMatch(JSON.stringify(openapi), /other-private|Other closed places/);

  cli(['access', 'revoke', 'private-places', '--user-id', grant.userId]);
  cli(['access', 'revoke', 'private-places', '--user-id', grant.userId], 'NO_CHANGE');
  assert.equal((await request(items, options)).status, 403);
  assert.equal((await request(next, options)).status, 403);
  for (const path of ['/features/collections?f=html', '/features/openapi?f=yaml']) {
    const metadata = await request(path, options);
    assert.equal(metadata.status, 200);
    assert.doesNotMatch(await metadata.text(), /private-places|Closed places/);
  }
});

test('a confirmed administrator can read all modes and an ordinary account lacks private access', async () => {
  for (const email of ['ordinary@example.test', 'administrator@example.test']) {
    await register(email, password);
  }
  const ordinary = await signIn('ordinary@example.test', password);
  const administrator = await signIn('administrator@example.test', password);
  const denied = await request(items, { headers: { Cookie: ordinary } });
  assert.equal(denied.status, 403);
  assert.equal((await denied.json()).code, 'Forbidden');
  assert.equal(denied.headers.get('www-authenticate'), null);

  const allowed = await request(items, { headers: { Cookie: administrator } });
  assert.equal(allowed.status, 200);
  assert.equal((await allowed.json()).id, 'central');
  const catalog = await request('/features/collections?f=json', { headers: { Cookie: administrator } });
  assert.deepEqual((await catalog.json()).collections.map(({ id }) => id),
    ['registered-places', 'places', 'private-places', 'other-private']);
  const api = await request('/features/openapi?f=json', { headers: { Cookie: administrator } });
  assert.ok((await api.json()).paths['/collections/other-private/items']);
  const head = await request(items, { method: 'HEAD', headers: { Cookie: administrator } });
  assert.equal(head.status, 200);
  cli(['users', 'block', '--email', 'administrator@example.test']);
  assert.equal((await request(items, { headers: { Cookie: administrator } })).status, 403);
  const users = cli(['users', 'list']).users;
  assert.deepEqual(publications(users.find(({ email }) => email === 'administrator@example.test')), ['places']);
  cli(['users', 'unblock', '--email', 'administrator@example.test']);
});

test('user summaries and the gateway reflect blocking and unblocking', async () => {
  const email = 'block-reader@example.test';
  const pending = 'unverified@example.test';
  await register(email, password, 'Block reader');
  const cookie = await signIn(email, password);
  const { user: { id } } = await session(cookie);
  assert.equal((await auth('sign-up/email', { email: pending, password, name: 'Unverified' })).status, 200);
  cli(['access', 'grant', 'private-places', '--email', email]);
  cli(['access', 'grant', 'private-places', '--email', pending]);
  const options = { headers: { Cookie: cookie } };
  assert.equal((await request(items, options)).status, 200);
  const readUser = (email) => cli(['users', 'list']).users.find((user) => user.email === email);
  const active = readUser(email);
  assert.equal(active.id, id);
  assert.equal(active.name, 'Block reader');
  assert.ok(Number.isFinite(Date.parse(active.registeredAt)));
  assert.equal(active.status, 'active');
  assert.deepEqual(publications(active), ['registered-places', 'places', 'private-places']);
  assert.ok(active.publications.every(({ anonymous }) => !anonymous));
  const unverified = readUser(pending);
  assert.equal(unverified.status, 'unverified');
  assert.deepEqual(publications(unverified), ['places']);
  assert.equal(unverified.publications[0].anonymous, true);
  assert.equal((await auth('sign-in/email', { email: pending, password })).status, 403);

  cli(['users', 'block', '--user-id', id]);
  cli(['users', 'block', '--email', email], 'NO_CHANGE');
  assert.equal((await request(items, options)).status, 403);
  assert.equal((await request(publicItems, options)).status, 200);
  assert.equal((await auth('sign-in/email', { email, password })).status, 403);
  const blocked = readUser(email);
  assert.equal(blocked.status, 'blocked');
  assert.deepEqual(publications(blocked), ['places']);
  assert.equal(blocked.publications[0].anonymous, true);
  cli(['users', 'unblock', '--email', email]);
  const confirmed = await signIn(email, password);
  assert.equal((await request(items, { headers: { Cookie: confirmed } })).status, 200);

});

test('CLI validation and delegation return one JSON result with stable codes', () => {
  assert.equal(cli(['status'], 'OK', 0, operator('agent')).access, 'ready');
  assert.equal(cli(['doctor', '--publication', 'private-places'], 'OK', 0, operator('agent')).publicationId, 'private-places');
  cli(['doctor', '--publication', 'absent'], 'NOT_FOUND', 3, operator('agent'));
  cli(['users', 'list'], 'FORBIDDEN', 4, operator('agent'));
  cli(['users', 'list'], 'FORBIDDEN', 4, operator('outsider'));
  cli(['users', 'list'], 'FORBIDDEN', 4, { GIS_ADMIN_KEY_FILE: '' });
  assert.ok(Array.isArray(cli(['users', 'list'], 'OK', 0, operator('reader')).users));
  cli(['status'], 'FORBIDDEN', 4, operator('reader'));
  cli(['users', 'block', '--email', 'absent@example.test'], 'FORBIDDEN', 4, operator('reader'));
  cli(['users', 'list'], 'FORBIDDEN', 4, operator('writer'));
  cli(['users', 'block', '--email', 'absent@example.test'], 'NOT_FOUND', 3, operator('writer'));
  cli(['users', 'block', '--email', 'not-an-email'], 'INVALID_INPUT', 2);
  cli(['access', 'grant', 'places', '--email', 'absent@example.test'], 'INVALID_INPUT', 2);
  cli(['access', 'grant', 'absent', '--email', 'absent@example.test'], 'NOT_FOUND', 3);
  cli(['access', 'grant', 'private-places', '--email', 'absent@example.test', '--user-id', 'another'],
    'INVALID_INPUT', 2);
});

test('separate local accounts use one CLI and only their own credentials', () => {
  const accessContainer = compose('ps', '-q', 'access');
  const output = dockerJson('run', '--rm', '--network', `container:${accessContainer}`,
    '--mount', `type=bind,src=${process.env.GIS_TEST_RESULTS},dst=/root/input,readonly`,
    '--entrypoint', '/bin/sh', process.env.GIS_TEST_CLI_IMAGE, 'tests/cli-local-accounts.sh');
  const results = output.split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(results.map(({ code }) => code), ['OK', 'OK', 'FORBIDDEN', 'FORBIDDEN']);
});

test('delegated changes are audited under the authenticated local account', async () => {
  const email = 'audited@example.test';
  await register(email, password, 'Audit reader');
  const { userId } = cli(['access', 'grant', 'private-places', '--email', email], 'OK', 0,
    { ...operator('writer'), USER: 'operator', USERNAME: 'operator', LOGNAME: 'operator' });
  cli(['users', 'block', '--user-id', userId], 'OK', 0, operator('writer'));
  const changes = compose('logs', '--no-color', '--no-log-prefix', 'access').split(/\r?\n/)
    .filter((line) => line.startsWith('{"event":"access.change"'))
    .map((line) => JSON.parse(line)).filter((event) => event.userId === userId);
  assert.deepEqual(changes, [
    { event: 'access.change', actor: 'writer', operation: 'access grant', userId, publicationId: 'private-places' },
    { event: 'access.change', actor: 'writer', operation: 'users block', userId },
  ]);
});

test('a grant survives access service recreation and dependency outages fail closed', async () => {
  const email = 'persistent-private@example.test';
  await register(email, password);
  const cookie = await signIn(email, password);
  const options = { headers: { Cookie: cookie } };
  cli(['access', 'grant', 'private-places', '--email', email]);
  compose('up', '-d', '--no-deps', '--force-recreate', '--wait', 'access');
  assert.equal((await request(items, options)).status, 200);
  for (const service of ['postgres', 'access']) {
    compose('stop', service);
    try {
      for (const requestOptions of [options, undefined]) {
        for (const path of [items, '/features/collections?f=json', '/features/openapi?f=json']) {
          const unavailable = await request(path, requestOptions);
          assert.equal(unavailable.status, 503, `${service}: ${path}`);
          assert.equal(unavailable.headers.get('cache-control'), 'no-store');
          assert.equal((await unavailable.json()).code, 'ServiceUnavailable');
        }
      }
      assert.equal((await request(publicItems, options)).status, 200);
      cli(['users', 'list'], 'FAILED', 1);
    } finally {
      compose('up', '-d', '--wait', service);
    }
  }
  assert.equal((await request(items, options)).status, 200);
  assert.equal((await request('/command', { method: 'POST' })).status, 404);
  assert.equal((await request('/internal/authorize/private-places', options)).status, 404);
});
