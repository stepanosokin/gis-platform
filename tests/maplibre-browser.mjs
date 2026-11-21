import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';

export async function renderMapLibre({ origin, results, name, script, frameCount, afterFirstRender }) {
  const dist = process.env.GIS_TEST_MAPLIBRE_DIST;
  assert.ok(dist, 'Set GIS_TEST_MAPLIBRE_DIST to the MapLibre GL JS dist directory.');
  const files = new Map(await Promise.all(['maplibre-gl.mjs', 'maplibre-gl-worker.mjs', 'maplibre-gl-shared.mjs']
    .map(async (file) => [`/${file}`, await readFile(join(dist, file))])));
  const html = `<!doctype html><meta charset="utf-8"><title>MapLibre browser test</title>
<div id="map" style="width: 640px; height: 480px"></div>
<script type="module">
  import { Map, getVersion, setWorkerUrl } from '/maplibre-gl.mjs';
  setWorkerUrl('/maplibre-gl-worker.mjs');
  const report = (result) => fetch('/result', { method: 'POST', body: JSON.stringify({ ...result, version: getVersion() }) });
  try {
    ${script}
  } catch (error) {
    await report({ error: error.message });
  }
</script>`;
  let notify;
  const frames = [];
  const result = new Promise((resolve) => { notify = resolve; });
  const server = createServer(async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    if (request.method === 'POST' && request.url === '/result') {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const frame = JSON.parse(Buffer.concat(chunks).toString());
      frames.push(frame);
      if (frames.length === 1 && !frame.error && afterFirstRender) {
        try {
          afterFirstRender();
        } catch (error) {
          frame.error = error.message;
        }
      }
      response.writeHead(204).end();
      if (frames.length === frameCount || frame.error) notify(frames);
    } else if (request.url === '/') {
      response.writeHead(200, { 'Content-Type': 'text/html' }).end(html);
    } else if (files.has(request.url)) {
      response.writeHead(200, { 'Content-Type': 'text/javascript' }).end(files.get(request.url));
    } else {
      response.writeHead(404).end();
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(Number(new URL(origin).port), '127.0.0.1', resolve);
  });
  const browser = spawn(process.env.GIS_TEST_CHROME, ['--headless=new', '--no-first-run', '--enable-unsafe-swiftshader',
    '--use-gl=angle', '--use-angle=swiftshader', `--user-data-dir=${join(results, `${name}-profile`)}`, origin],
  { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  browser.stderr.on('data', (data) => { stderr += data; });
  let timer;
  try {
    const evidence = await Promise.race([
      result,
      new Promise((_, reject) => {
        browser.once('error', reject);
        browser.once('exit', (code) => reject(new Error(`Browser exited before rendering ${name} (${code}).`)));
        timer = setTimeout(() => reject(new Error(`Browser timed out rendering ${name}.`)), 25_000);
      }),
    ]);
    await writeFile(join(results, `${name}.json`), JSON.stringify(evidence));
    for (const frame of evidence) {
      assert.equal(frame.error, undefined);
      assert.equal(frame.version, '6.19.0');
    }
    return evidence;
  } finally {
    clearTimeout(timer);
    browser.kill();
    browser.stderr.destroy();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await writeFile(join(results, `${name}.log`), stderr);
  }
}
