import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { X509Certificate } from 'node:crypto';
import { once } from 'node:events';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { get } from 'node:https';
import { connect, createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { test } from 'node:test';
import { auth, cookieFrom, emailLink, register, request, session, signIn } from './access-client.mjs';

const gateway = process.env.GIS_TEST_PUBLIC_URL;

test('a visitor registers, verifies email and signs in at the platform URL', async () => {
  const email = 'reader@example.test';
  const password = 'reader-password-15';
  const registration = await request('/account/register');
  assert.equal(registration.status, 200);
  assert.match(await registration.text(), /<form\b/);

  assert.equal((await auth('sign-up/email', { email, password, name: 'Reader' })).status, 200);
  assert.equal((await auth('sign-in/email', { email, password })).status, 403);

  const link = await emailLink(email, '/api/auth/verify-email');
  assert.equal(new URL(link).origin, gateway);
  const verification = await request(link);
  assert.equal(verification.status, 200);
  assert.match(await verification.text(), /email is verified/i);

  const login = await auth('sign-in/email', { email, password });
  assert.equal(login.status, 200);
  assert.equal(Object.hasOwn(await login.json(), 'token'), false);
  const session = login.headers.getSetCookie().find((value) => value.startsWith('gis.session_token='));
  assert.match(session, /; HttpOnly\b/i);
  assert.match(session, /; SameSite=Lax\b/i);
});

test('the profile keeps a stable ID and immutable normalized email while names may repeat', async () => {
  const password = 'profile-password-15';
  await register('Person.Name+Map@EXAMPLE.TEST', password, 'Common name');
  await register('personname@example.test', password, 'Common name');
  const cookie = await signIn('PERSON.NAME+MAP@EXAMPLE.TEST', password);
  const before = (await session(cookie)).user;
  assert.ok(before.id);
  assert.equal(before.email, 'person.name+map@example.test');
  const other = (await session(await signIn('personname@example.test', password))).user;
  assert.notEqual(before.id, other.id);

  assert.equal((await request('/account/profile', { headers: { Cookie: cookie } })).status, 200);
  assert.equal((await auth('update-user', { name: 'Different name' }, cookie)).status, 200);
  assert.equal((await auth('change-email', { newEmail: 'other@example.test' }, cookie)).status, 404);
  const update = await auth('update-user', { email: 'other@example.test' }, cookie);
  assert.ok(update.status >= 400 && update.status < 500);
  await auth('sign-up/email', { email: 'person.name+MAP@example.test', password: 'different-password-15', name: 'Duplicate' });
  assert.equal((await auth('sign-in/email', { email: before.email, password: 'different-password-15' })).status, 401);
  const updated = (await session(cookie)).user;
  assert.deepEqual([updated.id, updated.email, updated.name], [before.id, before.email, 'Different name']);
});

test('password change and email recovery revoke all previous sessions', async () => {
  const email = 'passwords@example.test';
  const initial = 'initial-password-15';
  const changed = 'changed-password-15';
  const recovered = 'recovered-password-15';
  await register(email, initial);
  const current = await signIn(email, initial);
  const other = await signIn(email, initial);
  assert.notEqual(current, other);

  const changePage = await request('/account/change-password', { headers: { Cookie: current } });
  assert.equal(changePage.status, 200);
  assert.match(await changePage.text(), /name="currentPassword"/);
  const invalid = await auth('change-password', { currentPassword: 'wrong-password', newPassword: changed }, current);
  assert.equal(invalid.status, 400);
  assert.ok((await session(other)).user);

  const change = await auth('change-password', { currentPassword: initial, newPassword: changed, revokeOtherSessions: false }, current);
  assert.equal(change.status, 200);
  const retained = cookieFrom(change);
  assert.equal(Object.hasOwn(await change.json(), 'token'), false);
  assert.ok((await session(retained)).user);
  assert.equal(await session(other), null);
  assert.equal(await session(current), null);
  assert.equal((await auth('sign-in/email', { email, password: initial })).status, 401);

  const second = await signIn(email, changed);
  assert.equal((await request('/account/forgot-password')).status, 200);
  assert.equal((await auth('request-password-reset', { email })).status, 200);
  const link = new URL(await emailLink(email, '/account/reset-password'));
  assert.equal(link.origin, gateway);
  const resetPage = await request(link.href);
  assert.equal(resetPage.status, 200);
  assert.equal(resetPage.headers.get('referrer-policy'), 'no-referrer');
  assert.match(await resetPage.text(), /name="newPassword"/);
  const token = link.searchParams.get('token');
  assert.ok(token);
  assert.equal((await auth('reset-password', { token, newPassword: recovered })).status, 200);
  assert.equal((await auth('reset-password', { token, newPassword: initial })).status, 400);
  assert.equal(await session(retained), null);
  assert.equal(await session(second), null);
  assert.equal((await auth('sign-in/email', { email, password: changed })).status, 401);
  assert.ok(await signIn(email, recovered));
});

const collection = '/features/collections/registered-places';

function features(path, cookie, headers) {
  return request(path, { headers: { ...headers, ...(cookie && { Cookie: cookie }) } });
}

async function document(path, cookie, headers) {
  const response = await features(path, cookie, headers);
  assert.equal(response.status, 200, path);
  assert.equal(response.headers.get('cache-control'), 'no-store', path);
  return response.json();
}

test('the catalog, OpenAPI and related URLs reflect the current session', async () => {
  const anonymous = await document('/features/collections?f=json');
  assert.deepEqual(anonymous.collections.map(({ id }) => id), ['places']);
  const jsonLdUrl = anonymous.links.find(({ type }) => type === 'application/ld+json').href;
  const publicLinkedData = await features(jsonLdUrl);
  assert.equal(publicLinkedData.status, 200);
  assert.match(publicLinkedData.headers.get('content-type'), /^application\/ld\+json/);
  assert.deepEqual((await publicLinkedData.json()).dataset.map((item) => item['@id']), [`${gateway}/features/collections/places`]);
  const html = await features('/features/collections?f=html');
  assert.match(html.headers.get('content-type'), /^text\/html/);
  assert.doesNotMatch(await html.text(), /registered-places|Registered example/);
  const openapi = await document('/features/openapi?f=json');
  assert.match(openapi.openapi, /^3\.0\./);
  assert.ok(openapi.paths['/collections/places/items']);
  assert.doesNotMatch(JSON.stringify(openapi), /registered-places|Registered example/);
  assert.equal((await document('/features/collections/places/items/central?f=json', 'gis.session_token=invalid')).id, 'central');

  for (const suffix of ['', '/items', '/items/central', '/schema', '/queryables']) {
    const denied = await features(`${collection}${suffix}?f=json`, 'gis.session_token=invalid');
    assert.equal(denied.status, 401, suffix);
    assert.match(denied.headers.get('www-authenticate'), /^Session\b/);
    assert.equal(denied.headers.get('cache-control'), 'no-store');
    assert.equal((await denied.json()).code, 'Unauthorized');
  }
  assert.equal((await features('/collections/registered-places/items')).status, 404);
  assert.equal((await features('/internal/authorize')).status, 404);

  await register('features@example.test', 'features-password-15');
  const cookie = await signIn('features@example.test', 'features-password-15');
  const catalog = await document('/features/collections?f=json', cookie);
  assert.deepEqual(catalog.collections.map(({ id }) => id), ['registered-places', 'places']);
  const linkedData = await request('/features/collections', { headers: { Accept: 'application/ld+json', Cookie: cookie } });
  assert.match(linkedData.headers.get('content-type'), /^application\/ld\+json/);
  assert.deepEqual((await linkedData.json()).dataset.map((item) => item['@id']), [
    `${gateway}${collection}`, `${gateway}/features/collections/places`,
  ]);
  const authenticatedHtml = await features('/features/collections?f=html', cookie);
  assert.match(await authenticatedHtml.text(), /registered-places/);
  const api = await document('/features/openapi?f=json', cookie);
  const operation = api.paths['/collections/registered-places/items'].get;
  assert.deepEqual(api.servers.map(({ url }) => url), [`${gateway}/features`]);
  assert.ok(operation.responses['401'].headers['WWW-Authenticate']);
  assert.ok(operation.responses['503']);
  assert.equal(api.components.securitySchemes.session.in, 'cookie');
  assert.deepEqual(operation.security, [{ session: [] }, { bearer: [] }]);
  assert.equal(api.paths['/collections/places/items'].get.security, undefined);
  for (const id of ['places', 'registered-places']) {
    const itemsPage = await features(`/features/collections/${id}/items?f=html`, cookie);
    assert.equal(itemsPage.status, 200);
    assert.match(itemsPage.headers.get('content-security-policy'), /script-src 'none'/);
    await itemsPage.body?.cancel();
  }

  const detail = await document(`${collection}?f=json`, cookie);
  const items = new URL(detail.links.find(({ rel, type }) => rel === 'items' && type === 'application/geo+json').href);
  assert.equal(items.origin, gateway);
  items.searchParams.set('limit', '1');
  const first = await document(items.href, cookie);
  const next = new URL(first.links.find(({ rel }) => rel === 'next').href);
  assert.equal(next.origin, gateway);
  assert.deepEqual((await document(next.href, cookie)).features.map(({ id }) => id), ['area/east']);
  assert.equal((await features(next.href)).status, 401);
});

function compose(...args) {
  const result = spawnSync('docker', ['compose', '-f', 'compose.yaml', '-f', 'compose.auth.yaml', '-f',
    'compose.mailpit.yaml', ...args], { encoding: 'utf8', timeout: 40_000, windowsHide: true });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout;
}

test('blocking a confirmed account takes effect on the next request with its existing session', async () => {
  const email = 'blocked@example.test';
  const password = 'blocked-password-15';
  await register(email, password);
  const cookie = await signIn(email, password);
  assert.equal((await document(`${collection}/items/central?f=json`, cookie)).id, 'central');

  compose('exec', '-T', 'postgres', 'psql', '-v', 'ON_ERROR_STOP=1', '-U', 'gis', '-d', 'gis',
    '-c', `UPDATE "user" SET active = false WHERE email = '${email}';`);
  const denied = await features(`${collection}/items/central?f=json`, cookie);
  assert.equal(denied.status, 403);
  assert.equal((await denied.json()).code, 'Forbidden');
  assert.equal(await session(cookie), null);
  assert.equal((await auth('sign-in/email', { email, password })).status, 403);
  assert.deepEqual((await document('/features/collections?f=json', cookie)).collections.map(({ id }) => id), ['places']);
});

test('account and session are preserved when PostgreSQL and access containers are recreated', async () => {
  const email = 'persistent@example.test';
  const password = 'persistent-password-15';
  await register(email, password, 'Persistent reader');
  const cookie = await signIn(email, password);
  const prior = (await session(cookie)).user;
  compose('up', '-d', '--no-deps', '--force-recreate', '--wait', 'postgres');
  compose('up', '-d', '--no-deps', '--force-recreate', '--wait', 'access');
  const existing = (await session(cookie)).user;
  assert.deepEqual([existing.id, existing.email, existing.name], [prior.id, email, 'Persistent reader']);
  assert.equal((await session(await signIn(email, password))).user.id, prior.id);
  assert.equal((await document(`${collection}/items/central?f=json`, cookie)).id, 'central');
});

test('access and PostgreSQL outages return Features 503 and leave public data available', async () => {
  const email = 'outage@example.test';
  const password = 'outage-password-15';
  await register(email, password);
  const cookie = await signIn(email, password);
  for (const component of ['access', 'postgres']) {
    compose('stop', component);
    try {
      for (const path of [`${collection}/items?f=json`, '/features/collections?f=json', '/features/openapi?f=json']) {
        const response = await features(path, cookie);
        assert.equal(response.status, 503, `${component}: ${path}`);
        assert.equal(response.headers.get('cache-control'), 'no-store');
        assert.equal((await response.json()).code, 'ServiceUnavailable');
      }
      const anonymous = await features(`${collection}/items?f=json`);
      assert.equal(anonymous.status, 503);
      assert.equal((await anonymous.json()).code, 'ServiceUnavailable');
      const login = await auth('sign-in/email', { email, password });
      assert.equal(login.status, 503);
      assert.equal((await login.json()).code, 'ServiceUnavailable');
      assert.equal((await document('/features/collections/places/items/central?f=json')).id, 'central');
    } finally {
      compose('up', '-d', '--no-deps', '--wait', component);
    }
    assert.equal((await document(`${collection}/items/central?f=json`, cookie)).id, 'central');
  }
});

function cliResult(args, exitCode = 0, env = process.env) {
  const { NODE_EXTRA_CA_CERTS: _ca, ...operatorEnv } = env;
  const result = spawnSync(process.execPath, ['dist/cli.js', ...args, '--json'], {
    encoding: 'utf8', timeout: 100_000, windowsHide: true, env: operatorEnv,
  });
  assert.ifError(result.error);
  assert.equal(result.status, exitCode, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}

function cli(...args) {
  return cliResult(['config', ...args]).data;
}

function httpsYaml(yaml, certificate = 'https-cert.pem', key = 'https-key.pem') {
  return yaml.replace('  host: localhost\n', `  host: localhost\n  tls:
    cert_file: ${certificate}
    key_file: ${key}
    ca_file: gateway-root.pem
`);
}

test('TLS rejects invalid certificate material before opening or closing routes', async () => {
  const filename = process.env.GIS_TEST_CONFIG;
  const current = await readFile(filename, 'utf8');
  const activeVersion = cliResult(['status']).data.currentVersion;
  const closedPort = process.env.GIS_TEST_EMPTY_TLS_PORT;
  const closedRedirect = process.env.GIS_TEST_EMPTY_REDIRECT_PORT;
  const empty = { ...process.env, GIS_STATE_DIR: join(dirname(filename), 'empty-tls-state'),
    COMPOSE_PROJECT_NAME: `${process.env.COMPOSE_PROJECT_NAME}-empty-tls`, GIS_HTTP_REDIRECT_PORT: closedRedirect };
  const ready = '/features/collections/places?f=json';
  for (const [name, yaml, reason] of [
    ['missing', httpsYaml(current, 'missing-cert.pem'), /TLS.*file/i],
    ['malformed', httpsYaml(current, 'places.geojson'), /TLS certificate.*PEM/i],
    ['incomplete-chain', httpsYaml(current, 'https-leaf.pem'), /TLS certificate chain/i],
    ['untrusted-chain', httpsYaml(current).replace('ca_file: gateway-root.pem', 'ca_file: https-next-leaf.pem'), /TLS certificate chain/i],
    ['wrong-key', httpsYaml(current, 'https-cert.pem', 'https-next-key.pem'), /TLS private key/i],
    ['wrong-host', httpsYaml(current).replace('host: localhost', 'host: other.test'), /TLS certificate.*hostname/i],
    ['cn-without-san', httpsYaml(current, 'https-cn-only-cert.pem', 'https-cn-only-key.pem'), /TLS certificate.*hostname/i],
    ['redirect-port', httpsYaml(current).replace(/  port: \d+\n/,
      `  port: ${new URL(process.env.GIS_TEST_HTTP_REDIRECT_URL).port}\n`), /redirect port.*HTTPS port/i],
    ['expired', httpsYaml(current, 'https-expired-cert.pem', 'https-expired-key.pem'), /TLS certificate.*expired/i],
    ['future', httpsYaml(current, 'https-future-cert.pem', 'https-future-key.pem'), /TLS certificate.*not yet valid/i],
  ]) {
    const candidate = join(dirname(filename), `tls-${name}.yaml`);
    await writeFile(candidate, yaml);
    const { planId } = cli('plan', candidate);
    const failure = cliResult(['config', 'apply', planId], 6);
    assert.match(failure.data.message, reason);
    assert.equal(failure.code, 'APPLY_FAILED');
    assert.equal(cliResult(['status']).data.currentVersion, activeVersion);
    assert.equal((await request(ready)).status, 200);

    if (name === 'incomplete-chain') {
      const first = join(dirname(filename), 'first-start-invalid-tls.yaml');
      await writeFile(first, yaml.replace(/  port: \d+\n/, `  port: ${closedPort}\n`));
      const separate = cliResult(['config', 'plan', first], 0, empty).data;
      assert.equal(cliResult(['config', 'apply', separate.planId], 6, empty).code, 'APPLY_FAILED');
      assert.equal(cliResult(['status'], 0, empty).data.currentVersion, null);
      await assert.rejects(request(`https://localhost:${closedPort}${ready}`));
      await assert.rejects(request(`http://localhost:${closedRedirect}${ready}`));
    }
  }
});

function peerFingerprint(url) {
  return new Promise((resolve, reject) => {
    const req = get(url, { agent: false, signal: AbortSignal.timeout(5_000) }, (response) => {
      resolve(response.socket.getPeerX509Certificate().fingerprint256);
      response.resume();
    });
    req.on('error', reject);
  });
}

test('the public HTTPS address is independent of the gateway port', async (t) => {
  const filename = process.env.GIS_TEST_CONFIG;
  const previousVersion = cliResult(['status']).data.currentVersion;
  const gatewayPort = Number(new URL(process.env.GIS_TEST_HTTPS_URL).port || 443);
  let forwarding = false;
  const proxy = createServer((client) => {
    if (!forwarding) {
      client.destroy();
      return;
    }
    const upstream = connect(gatewayPort, '127.0.0.1');
    client.on('error', () => upstream.destroy());
    upstream.on('error', () => client.destroy());
    client.on('close', () => upstream.destroy());
    upstream.on('close', () => client.destroy());
    client.pipe(upstream).pipe(client);
  });
  proxy.listen(0, '127.0.0.1');
  await once(proxy, 'listening');
  t.after(() => new Promise((resolve) => proxy.close(resolve)));
  const publicOrigin = `https://localhost:${proxy.address().port}`;
  const candidate = join(dirname(filename), 'public-address.yaml');
  const yaml = httpsYaml(await readFile(filename, 'utf8')).replace('  host: localhost\n',
    `  host: localhost\n  public_url: ${publicOrigin}\n`);
  await writeFile(candidate, yaml);

  const plan = cli('plan', candidate);
  assert.equal(plan.previousPublicUrl, gateway);
  assert.equal(plan.publicUrl, publicOrigin);
  cli('apply', plan.planId);
  t.after(() => cli('apply', cli('plan', '--rollback-to', previousVersion).planId));
  const diagnostics = cliResult(['doctor']).data;
  assert.equal(diagnostics.gateway, 'ready');
  assert.equal(diagnostics.tls.state, 'ready');

  forwarding = true;
  const collectionUrl = `${publicOrigin}/features/collections/places`;
  const metadata = await document(`${collectionUrl}?f=json`, undefined, { Connection: 'close' });
  const items = metadata.links.find(({ rel, type }) => rel === 'items' && type === 'application/geo+json');
  assert.equal(items?.href, `${collectionUrl}/items?f=json`);
  assert.equal((await document(items.href, undefined, { Connection: 'close' })).type, 'FeatureCollection');
  const openApi = await document(`${publicOrigin}/features/openapi?f=json`, undefined, { Connection: 'close' });
  assert.equal(openApi.servers[0].url, `${publicOrigin}/features`);
});

test('HTTPS serves the account flow with a Secure session cookie', async () => {
  const filename = process.env.GIS_TEST_CONFIG;
  const current = await readFile(filename, 'utf8');
  await writeFile(filename, httpsYaml(current));
  const plan = cli('plan', filename);
  cli('apply', plan.planId);
  const origin = process.env.GIS_TEST_HTTPS_URL;
  const redirectOrigin = process.env.GIS_TEST_HTTP_REDIRECT_URL;
  assert.equal(plan.previousPublicUrl, gateway);
  assert.equal(plan.publicUrl, origin);
  assert.equal(plan.previousUrl, `${gateway}${collection}`);
  assert.equal(plan.newUrl, `${origin}${collection}`);
  const httpsPage = await request(`${origin}/account/login`);
  assert.equal(httpsPage.status, 200);
  assert.equal(httpsPage.headers.get('strict-transport-security'), null);
  const path = '/account/login?return=%2Ffeatures';
  const redirected = await request(`${redirectOrigin}${path}`, {
    redirect: 'manual', headers: { Host: 'other.test', 'X-Forwarded-Proto': 'https' },
  });
  assert.equal(redirected.status, 308);
  assert.equal(redirected.headers.get('location'), `${origin}${path}`);
  assert.equal(redirected.headers.get('strict-transport-security'), null);
  const plainHttp = await request('/account/login', { redirect: 'manual' }).catch(() => null);
  assert.ok(plainHttp === null || !plainHttp.ok);

  const email = 'https@example.test';
  const password = 'https-password-15';
  assert.equal((await auth('sign-up/email', { email, password, name: 'HTTPS reader' }, undefined, origin)).status, 200);
  const link = await emailLink(email, '/api/auth/verify-email');
  assert.equal(new URL(link).origin, origin);
  assert.equal((await request(link)).status, 200);
  const login = await auth('sign-in/email', { email, password }, undefined, origin);
  assert.equal(login.status, 200);
  const setCookie = login.headers.getSetCookie().find((value) => value.startsWith('__Secure-gis.session_token='));
  for (const attribute of [/; Secure\b/i, /; HttpOnly\b/i, /; SameSite=Lax\b/i]) assert.match(setCookie, attribute);
  const cookie = cookieFrom(login);
  assert.equal((await document(`${origin}${collection}/items/central?f=json`, cookie)).id, 'central');
  const api = await document(`${origin}/features/openapi?f=json`, cookie);
  assert.equal(api.servers[0].url, `${origin}/features`);
  assert.equal(api.components.securitySchemes.session.name, '__Secure-gis.session_token');
  const metadata = await document(`${origin}${collection}?f=json`, cookie, {
    Forwarded: 'host=other.test;proto=http', 'X-Forwarded-Host': 'other.test',
    'X-Forwarded-Proto': 'http', 'X-Forwarded-Port': '9',
  });
  assert.ok(metadata.links.length);
  for (const { href } of metadata.links) assert.equal(new URL(href).origin, origin);

  const initial = new X509Certificate(await readFile(join(dirname(filename), 'https-leaf.pem')));
  const rotated = new X509Certificate(await readFile(join(dirname(filename), 'https-next-leaf.pem')));
  assert.equal(await peerFingerprint(origin), initial.fingerprint256);
  assert.deepEqual(cliResult(['doctor']).data.tls,
    { state: 'ready', expiresAt: initial.validToDate.toISOString() });
  const beforeRotation = cli('plan', filename);
  await writeFile(join(dirname(filename), 'https-cert.pem'), await readFile(join(dirname(filename), 'https-next-cert.pem')));
  assert.match(cliResult(['config', 'apply', beforeRotation.planId], 6).data.message, /TLS files changed after planning/);
  const invalidRotation = cli('plan', filename);
  assert.match(cliResult(['config', 'apply', invalidRotation.planId], 6).data.message, /TLS private key/);
  assert.equal(cliResult(['status']).data.currentVersion, plan.planId);
  assert.equal(await peerFingerprint(origin), initial.fingerprint256);
  await writeFile(join(dirname(filename), 'https-key.pem'), await readFile(join(dirname(filename), 'https-next-key.pem')));
  const rotation = cli('plan', filename);
  cli('apply', rotation.planId);
  assert.equal(await peerFingerprint(origin), rotated.fingerprint256);
  assert.equal(cliResult(['doctor']).data.tls.expiresAt, rotated.validToDate.toISOString());

  const archive = join(process.env.GIS_STATE_DIR, 'tls', plan.planId);
  const backup = `${archive}-backup`;
  await rename(archive, backup);
  try {
    const missing = cliResult(['config', 'plan', '--rollback-to', plan.planId], 2);
    assert.match(missing.data.message, /archived TLS files.*selected version/i);
  } finally {
    await rename(backup, archive);
  }
  const certFile = join(archive, 'cert.pem');
  const originalCertificate = await readFile(certFile);
  await writeFile(certFile, await readFile(join(dirname(filename), 'https-next-cert.pem')));
  try {
    const changed = cliResult(['config', 'plan', '--rollback-to', plan.planId], 2);
    assert.match(changed.data.message, /archived TLS files.*selected version/i);
  } finally {
    await writeFile(certFile, originalCertificate);
  }
  assert.equal(await peerFingerprint(origin), rotated.fingerprint256);
  const rollback = cli('plan', '--rollback-to', plan.planId);
  cli('apply', rollback.planId);
  assert.equal(await peerFingerprint(origin), initial.fingerprint256);

  await writeFile(filename, httpsYaml(current).replace('    cert_file: https-cert.pem\n', ''));
  const http = cli('plan', filename);
  assert.equal(http.previousUrl, `${origin}${collection}`);
  assert.equal(http.newUrl, `${gateway}${collection}`);
  cli('apply', http.planId);
  await assert.rejects(request(`${origin}/account/login`));
  if (redirectOrigin !== gateway) await assert.rejects(request(`${redirectOrigin}${path}`));
  const httpLogin = await auth('sign-in/email', { email, password });
  assert.equal(httpLogin.status, 200);
  const httpCookie = cookieFrom(httpLogin);
  assert.match(httpCookie, /^gis\.session_token=/);
  const cookieHeader = httpLogin.headers.getSetCookie().find((value) => value.startsWith('gis.session_token='));
  assert.doesNotMatch(cookieHeader, /; Secure\b/i);
  assert.equal((await document('/features/openapi?f=json', httpCookie)).servers[0].url, `${gateway}/features`);
  assert.equal(cliResult(['doctor']).data.tls, undefined);
});
