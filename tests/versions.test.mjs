import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { get } from 'node:https';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { setTimeout } from 'node:timers/promises';
import { promisify } from 'node:util';

const run = promisify(execFile);
const file = process.env.GIS_TEST_CONFIG;
const gateway = process.env.GIS_TEST_PUBLIC_URL;
const original = await readFile(file, 'utf8');
const port = new URL(gateway).port;

async function cli(...args) {
  const result = await run(process.execPath, ['dist/cli.js', ...args, '--json'], { windowsHide: true })
    .catch((error) => {
      if (typeof error.code !== 'number') throw error;
      return { ...error, exitCode: error.code };
    });
  return { ...JSON.parse(result.stdout), exitCode: result.exitCode ?? 0 };
}

async function collection() {
  const response = await fetch(`${gateway}/features/collections/places?f=json`, { signal: AbortSignal.timeout(5000) });
  assert.equal(response.status, 200);
  return response.json();
}

test('a rollback plan restores the previous publication and OpenAPI', async () => {
  const first = await cli('status');
  assert.equal(first.code, 'OK');
  assert.ok(first.data.currentVersion);
  try {
    await writeFile(file, original.replace('Example places', 'Updated places'));
    const plan = await cli('config', 'plan', file);
    assert.equal(plan.code, 'OK');
    assert.deepEqual(plan.data.changed, ['places']);
    assert.equal((await cli('config', 'apply', plan.data.planId)).code, 'OK');
    assert.equal((await collection()).title, 'Updated places');

    const rollback = await cli('config', 'plan', '--rollback-to', first.data.currentVersion);
    assert.equal(rollback.code, 'OK');
    assert.equal(rollback.data.targetVersion, first.data.currentVersion);
    assert.equal(rollback.data.baseVersion, plan.data.planId);
    assert.equal((await cli('config', 'apply', rollback.data.planId)).code, 'OK');
    assert.equal((await collection()).title, 'Example places');
    const api = await fetch(`${gateway}/features/openapi?f=json`, { signal: AbortSignal.timeout(5000) });
    assert.equal(api.status, 200);
    assert.ok((await api.json()).paths['/collections/places/items']);
  } finally {
    await writeFile(file, original);
  }
});

test('a changed source that cannot be read leaves the working version open', async () => {
  const { data: { currentVersion } } = await cli('status');
  try {
    await writeFile(file, original.replace('path: places.geojson', 'path: unavailable.geojson'));
    const plan = await cli('config', 'plan', file);
    assert.equal(plan.code, 'OK');
    const result = await cli('config', 'apply', plan.data.planId);
    assert.equal(result.code, 'APPLY_FAILED');
    assert.equal(result.exitCode, 6);
    assert.equal(result.data.currentVersion, currentVersion);
    assert.equal((await cli('status')).data.currentVersion, currentVersion);
    assert.equal((await collection()).title, 'Example places');
  } finally {
    await writeFile(file, original);
  }
});

test('a changed source that cannot serve Features fails preflight', async () => {
  const filename = join(dirname(file), 'wrong-geojson-type.geojson');
  const source = JSON.parse(await readFile(join(dirname(file), 'places.geojson'), 'utf8'));
  await writeFile(filename, JSON.stringify({ ...source, type: 'UnexpectedType' }));
  const plan = await planYaml(original.replace('path: places.geojson', 'path: wrong-geojson-type.geojson'));
  const { data: { currentVersion } } = await cli('status');
  const result = await cli('config', 'apply', plan.planId);
  assert.equal(result.code, 'APPLY_FAILED');
  assert.equal(result.exitCode, 6);
  assert.equal((await cli('status')).data.currentVersion, currentVersion);
  assert.equal((await collection()).title, 'Example places');
});

test('a replacement of the source at the same path is included in the plan', async () => {
  const filename = join(dirname(file), 'places.geojson');
  const originalData = await readFile(filename, 'utf8');
  const source = JSON.parse(originalData);
  source.features[0].properties.name = 'Changed in place';
  await writeFile(filename, JSON.stringify(source));
  try {
    const plan = await planYaml(original);
    assert.deepEqual(plan.changed, ['places']);
    assert.ok(plan.services.includes('pygeoapi'));
    assert.equal((await cli('config', 'apply', plan.planId)).code, 'OK');
    const reply = await fetch(`${gateway}/features/collections/places/items/central?f=json`);
    assert.equal(reply.status, 200);
    assert.equal((await reply.json()).properties.name, 'Changed in place');
  } finally {
    await writeFile(filename, originalData);
  }
  const reset = await planYaml(original);
  assert.equal((await cli('config', 'apply', reset.planId)).code, 'OK');
});

test('a source replaced after planning requires a new plan even when the YAML is unchanged', async () => {
  const filename = join(dirname(file), 'places.geojson');
  const originalData = await readFile(filename, 'utf8');
  const plan = await planYaml(original);
  assert.deepEqual(plan.services, []);
  try {
    await writeFile(filename, JSON.stringify(JSON.parse(originalData)));
    const result = await cli('config', 'apply', plan.planId);
    assert.equal(result.exitCode, 6);
    assert.equal(result.code, 'APPLY_FAILED');
    assert.equal(result.data.currentVersion, plan.baseVersion);
    assert.equal((await cli('status')).data.phase, 'ready');
  } finally {
    await writeFile(filename, originalData);
  }
});

async function planYaml(yaml) {
  try {
    await writeFile(file, yaml);
    const result = await cli('config', 'plan', file);
    assert.equal(result.code, 'OK');
    return result.data;
  } finally {
    await writeFile(file, original);
  }
}

test('a stale plan is rejected and completed apply returns its saved result with the latest version', async () => {
  const obsolete = await planYaml(original.replace('Example places', 'Obsolete places'));
  const newPlan = await planYaml(original.replace('Example places', 'Confirmed places'));
  assert.equal((await cli('config', 'apply', newPlan.planId)).code, 'OK');
  const stale = await cli('config', 'apply', obsolete.planId);
  assert.equal(stale.code, 'PLAN_STALE');
  assert.equal(stale.exitCode, 5);
  assert.equal(stale.data.currentVersion, newPlan.planId);
  assert.equal((await collection()).title, 'Confirmed places');

  const next = await planYaml(original);
  assert.equal((await cli('config', 'apply', next.planId)).code, 'OK');
  const repeated = await cli('config', 'apply', newPlan.planId);
  assert.equal(repeated.code, 'OK');
  assert.equal(repeated.data.planId, newPlan.planId);
  assert.equal(repeated.data.currentVersion, next.planId);
  assert.equal((await collection()).title, 'Example places');
});

test('the gateway closes sibling routes during apply, and applying survives a disconnected caller', async () => {
  const next = await planYaml(original + original.slice(original.indexOf('  places:')).replace('  places:', '  sibling:'));
  const caller = spawn(process.execPath, ['dist/cli.js', 'config', 'apply', next.planId, '--json'],
    { stdio: 'ignore', windowsHide: true });
  const finished = once(caller, 'exit');
  try {
    const deadline = Date.now() + 30_000;
    let observedClosed = false;
    while (Date.now() < deadline && !observedClosed) {
      const state = await cli('status');
      if (state.data.phase === 'switch') {
        assert.ok(state.data.closedRoutes.includes(`${gateway}/features/collections/places`));
        const reply = await fetch(`${gateway}/features/collections/places/items?f=json`, {
          signal: AbortSignal.timeout(1000),
        }).catch(() => null);
        observedClosed = reply?.status === 503;
        if (reply) await reply.body?.cancel();
      }
      if (!observedClosed) await setTimeout(100);
    }
    assert.ok(observedClosed, 'Caddy should answer 503 before opening the new version');
    const concurrent = await cli('config', 'apply', next.planId);
    assert.equal(concurrent.code, 'APPLY_IN_PROGRESS');
    assert.equal(concurrent.exitCode, 5);
    assert.ok(caller.kill());
    await finished;

    let replay;
    for (let attempts = 0; attempts < 100; attempts++) {
      replay = await cli('config', 'apply', next.planId);
      if (replay.code !== 'APPLY_IN_PROGRESS') break;
      await setTimeout(200);
    }
    assert.equal(replay.code, 'OK');
    assert.equal(replay.data.currentVersion, next.planId);
    const response = await fetch(`${gateway}/features/collections/sibling/items?f=json`);
    assert.equal(response.status, 200);
    await response.body?.cancel();
  } finally {
    await finished;
  }
});

async function withOccupiedPort(action) {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port: occupied } = server.address();
  await new Promise((resolve) => server.close(resolve));
  const name = `${process.env.COMPOSE_PROJECT_NAME}-port-blocker`;
  await run('docker', ['run', '--rm', '-d', '--name', name, '-p', `127.0.0.1:${occupied}:80`,
    'caddy:2.10.2-alpine@sha256:4c6e91c6ed0e2fa03efd5b44747b625fec79bc9cd06ac5235a779726618e530d',
    'caddy', 'file-server', '--listen', ':80'], { windowsHide: true });
  try {
    await action(original.replace(`port: ${port}`, `port: ${occupied}`));
  } finally {
    await run('docker', ['rm', '-f', name], { windowsHide: true });
  }
}

test('a startup failure restores the previous routes and saves exit code 6', async () => {
  const before = await cli('status');
  await withOccupiedPort(async (yaml) => {
    const candidate = await planYaml(yaml);
    assert.equal(candidate.publications.find(({ publicationId }) => publicationId === 'places').previousUrl,
      `${gateway}/features/collections/places`);
    const failed = await cli('config', 'apply', candidate.planId);
    assert.equal(failed.code, 'APPLY_FAILED');
    assert.equal(failed.exitCode, 6);
    assert.equal(failed.data.currentVersion, before.data.currentVersion);
    assert.equal((await cli('status')).data.phase, 'ready');
    assert.equal((await collection()).title, 'Example places');
    assert.deepEqual(await cli('config', 'apply', candidate.planId), failed);
  });
});

test('an incomplete recovery reports the last confirmed version and keeps routes closed', async () => {
  const certificatePath = join(dirname(file), 'https-cert.pem');
  const certificateBackup = `${certificatePath}.test-backup`;
  const certificate = await readFile(certificatePath);
  const https = await planYaml(original.replace(`port: ${port}`, `port: ${port}
  tls:
    cert_file: https-cert.pem
    key_file: https-key.pem`));
  assert.equal((await cli('config', 'apply', https.planId)).code, 'OK');
  const status = () => new Promise((resolve) => {
    const req = get(`https://localhost:${port}/features/collections/places?f=json`, {
      ca: certificate, signal: AbortSignal.timeout(2000),
    }, (res) => { res.resume(); resolve(res.statusCode); });
    req.on('error', () => resolve(undefined));
  });
  assert.equal(await status(), 200);

  await rename(certificatePath, certificateBackup);
  try {
    await withOccupiedPort(async (yaml) => {
      const candidate = await planYaml(yaml);
      const failed = await cli('config', 'apply', candidate.planId);
      assert.equal(failed.code, 'RECOVERY_INCOMPLETE');
      assert.equal(failed.exitCode, 7);
      const reported = await cli('status');
      assert.equal(reported.exitCode, 7);
      assert.equal(reported.data.currentVersion, https.planId);
      assert.ok(reported.data.closedRoutes.includes(`https://localhost:${port}/features/collections/places`));
      assert.ok([undefined, 503].includes(await status()));
      assert.equal((await cli('config', 'apply', candidate.planId)).code, 'RECOVERY_INCOMPLETE');
    });
  } finally {
    await rename(certificateBackup, certificatePath);
  }
  const repaired = await planYaml(original);
  assert.equal((await cli('config', 'apply', repaired.planId)).code, 'OK');
  assert.equal((await collection()).title, 'Example places');
});

test('preflight failure never prints the contents of a secret file', async () => {
  const secret = 'example-secret-sentinel';
  const filename = join(dirname(file), 'invalid-auth-secret');
  await writeFile(filename, secret);
  const plan = await planYaml(`${original}auth:
  mode: development
  secret_file: invalid-auth-secret
  postgres_password_file: invalid-auth-secret
`);
  const failure = await cli('config', 'apply', plan.planId);
  assert.equal(failure.code, 'APPLY_FAILED');
  assert.equal(failure.exitCode, 6);
  assert.ok(!JSON.stringify({ plan, failure }).includes(secret));
  assert.equal((await collection()).title, 'Example places');
});
