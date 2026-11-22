import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

export async function executeQgis(code) {
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
