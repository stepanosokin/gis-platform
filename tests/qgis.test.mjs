import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { register, signIn } from './access-client.mjs';

async function executeQgis(code) {
  const source = process.env.GIS_QGIS_MCP_SOURCE ??
    'https://github.com/nkarasiak/qgis-mcp/archive/refs/heads/main.zip';
  const server = spawn('uvx', ['--offline', '--from', source, 'qgis-mcp-server'], {
    env: { ...process.env, QGIS_MCP_HOST: '127.0.0.1', QGIS_MCP_INSTANCES: '' },
    stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true, signal: AbortSignal.timeout(65_000),
  });
  let serverError;
  server.on('error', (error) => { serverError = error; });
  server.stdin.on('error', (error) => { serverError ??= error; });
  const output = createInterface({ input: server.stdout });
  const messages = output[Symbol.asyncIterator]();
  let nextId = 0;
  const send = (message) => server.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
  async function call(method, params) {
    const id = ++nextId;
    send({ id, method, params });
    for (;;) {
      const line = await messages.next();
      if (line.done) throw serverError ?? new Error('QGIS MCP server closed. Open QGIS and start the plugin server.');
      const response = JSON.parse(line.value);
      if (response.id !== id) continue;
      assert.equal(response.error, undefined, JSON.stringify(response.error));
      return response.result;
    }
  }
  try {
    await call('initialize', {
      protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'gis-platform-tests', version: '1' },
    });
    send({ method: 'notifications/initialized' });
    const result = await call('tools/call', { name: 'execute_code', arguments: { code, timeout: 40 } });
    assert.equal(result.isError ?? false, false, JSON.stringify(result.content));
    const report = result.structuredContent ?? JSON.parse(result.content[0].text);
    assert.equal(report.executed, true, JSON.stringify(report));
    return report.stdout;
  } finally {
    output.close();
    server.stdin.end();
    server.kill();
  }
}

test('an open QGIS connection refreshes private collections after login and reads their features', async () => {
  const email = 'qgis-reader@example.test';
  const password = 'local-QGIS-fixture-password';
  await register(email, password);
  const grant = spawnSync(process.execPath, ['dist/cli.js', 'access', 'grant', 'private-places', '--email', email, '--json'],
    { encoding: 'utf8', timeout: 15_000, windowsHide: true });
  assert.ifError(grant.error);
  assert.equal(grant.status, 0, grant.stderr || grant.stdout);
  assert.equal(JSON.parse(grant.stdout).code, 'OK');

  const file = join(process.env.GIS_TEST_RESULTS, 'qgis-session.json');
  const script = new URL('qgis-discovery.py', import.meta.url);
  const fixture = { url: `${process.env.GIS_TEST_PUBLIC_URL}/features`, cookie: await signIn(email, password) };
  await writeFile(file, JSON.stringify(fixture), { mode: 0o600 });
  try {
    const source = JSON.stringify(fileURLToPath(script));
    const stdout = await executeQgis(`from pathlib import Path\nfixture_path = ${JSON.stringify(file)}\nexec(compile(Path(${source}).read_text(encoding="utf-8"), ${source}, "exec"))`);
    const report = JSON.parse(stdout.trim().split('\n').at(-1));
    assert.deepEqual(report.before, ['places']);
    assert.deepEqual(report.after, ['places', 'private-places', 'registered-places']);
    assert.equal(report.features, 3);
    console.log(`QGIS ${report.version}: private collection appeared in the same dialog; ${report.features} features read.`);
  } finally {
    await rm(file, { force: true });
  }
});
