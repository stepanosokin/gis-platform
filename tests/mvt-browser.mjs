import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';

export async function renderMvt({ origin, source, layer, secret, results, afterFirstRender }) {
  const dist = process.env.GIS_TEST_MAPLIBRE_DIST;
  assert.ok(dist, 'Set GIS_TEST_MAPLIBRE_DIST to the MapLibre GL JS dist directory.');
  const files = new Map(await Promise.all(['maplibre-gl.mjs', 'maplibre-gl-worker.mjs', 'maplibre-gl-shared.mjs']
    .map(async (name) => [`/${name}`, await readFile(join(dist, name))])));
  const html = `<!doctype html><meta charset="utf-8"><title>MVT browser test</title>
<div id="map" style="width: 640px; height: 480px"></div>
<script type="module">
  import { Map, getVersion, setWorkerUrl } from '/maplibre-gl.mjs';
  setWorkerUrl('/maplibre-gl-worker.mjs');
  const fixture = ${JSON.stringify({ source, layer, secret })};
  const report = (result) => fetch('/result', { method: 'POST', body: JSON.stringify(result) });
  function render() {
    return new Promise((resolve, reject) => {
    const map = new Map({
      container: 'map', center: [1, 1], zoom: 5, attributionControl: false,
      transformRequest: (url) => url === fixture.source || url.startsWith(fixture.source + '/')
        ? { url, headers: { Authorization: 'Bearer ' + fixture.secret } } : { url },
      style: {
        version: 8,
        sources: { observations: { type: 'vector', url: fixture.source } },
        layers: [{ id: 'points', type: 'circle', source: 'observations', 'source-layer': fixture.layer,
          paint: { 'circle-radius': 10, 'circle-color': '#2559bc' } }],
      },
    });
    map.once('error', ({ error }) => reject(error));
    map.once('idle', () => {
      const features = map.queryRenderedFeatures({ layers: ['points'] });
      map.remove();
      resolve({ version: getVersion(), features: features.map(({ properties }) => properties) });
    });
    });
  }
  try {
    await report(await render());
    await report(await render());
  } catch (error) {
    report({ error: error.message });
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
      if (frames.length === 1 && !frame.error) {
        try {
          afterFirstRender();
        } catch (error) {
          frame.error = error.message;
        }
      }
      response.writeHead(204).end();
      if (frames.length === 2 || frame.error) notify(frames);
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
    '--use-gl=angle', '--use-angle=swiftshader', `--user-data-dir=${join(results, 'mvt-browser-profile')}`, origin],
  { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  browser.stderr.on('data', (data) => { stderr += data; });
  let timer;
  try {
    const evidence = await Promise.race([
      result,
      new Promise((_, reject) => {
        browser.once('error', reject);
        browser.once('exit', (code) => reject(new Error(`Browser exited before rendering MVT (${code}).`)));
        timer = setTimeout(() => reject(new Error('Browser timed out rendering MVT.')), 25_000);
      }),
    ]);
    await writeFile(join(results, 'mvt-browser.json'), JSON.stringify(evidence));
    for (const [index, label] of ['Greenwich', 'Greenwich after COMMIT'].entries()) {
      const frame = evidence[index];
      assert.equal(frame.error, undefined);
      assert.equal(frame.version, '6.19.0');
      assert.ok(frame.features.some((feature) => feature.id === 'row-1' && feature.label === label));
    }
  } finally {
    clearTimeout(timer);
    browser.kill();
    browser.stderr.destroy();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await writeFile(join(results, 'mvt-browser.log'), stderr);
  }
}
