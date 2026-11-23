import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { auth, register, signIn } from './access-client.mjs';
import { executeQgis } from './qgis-client.mjs';

async function checkDiscovery(header, getValue) {
  const email = `qgis-${header.toLowerCase()}@example.test`;
  const password = 'local-QGIS-fixture-password';
  await register(email, password);
  const grant = spawnSync(process.execPath, ['dist/cli.js', 'access', 'grant', 'private-places', '--email', email, '--json'],
    { encoding: 'utf8', timeout: 15_000, windowsHide: true });
  assert.ifError(grant.error);
  assert.equal(grant.status, 0, grant.stderr || grant.stdout);
  assert.equal(JSON.parse(grant.stdout).code, 'OK');

  const file = join(process.env.GIS_TEST_RESULTS, 'qgis-session.json');
  const script = new URL('qgis-discovery.py', import.meta.url);
  const fixture = { url: `${process.env.GIS_TEST_PUBLIC_URL}/pygeoapi/features`, header, value: await getValue(await signIn(email, password)) };
  await writeFile(file, JSON.stringify(fixture), { mode: 0o600 });
  try {
    const source = JSON.stringify(fileURLToPath(script));
    const stdout = await executeQgis(`from pathlib import Path\nfixture_path = ${JSON.stringify(file)}\nexec(compile(Path(${source}).read_text(encoding="utf-8"), ${source}, "exec"))`);
    const report = JSON.parse(stdout.trim().split('\n').at(-1));
    assert.deepEqual(report.before, ['places']);
    assert.deepEqual(report.after, ['places', 'private-places', 'registered-places']);
    assert.equal(report.features, 3);
    console.log(`QGIS ${report.version}, ${header}: private collection appeared in the same dialog; ${report.features} features read.`);
  } finally {
    await rm(file, { force: true });
  }
}

test('an open QGIS connection refreshes private collections after login and reads their features', () =>
  checkDiscovery('Cookie', (cookie) => cookie));

test('an open QGIS connection discovers and reads private collections with a named Bearer token', () =>
  checkDiscovery('Authorization', async (cookie) => {
    const response = await auth('tokens/create', { name: 'QGIS Desktop' }, cookie);
    assert.equal(response.status, 201);
    return `Bearer ${(await response.json()).secret}`;
  }));
