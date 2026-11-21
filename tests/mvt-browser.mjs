import assert from 'node:assert/strict';
import { renderMapLibre } from './maplibre-browser.mjs';

export async function renderVectorTiles({ origin, source, layer, secret, results, name,
  frameCount = 1, afterFirstRender }) {
  const tilePath = source.split('?')[0] + '/';
  const script = `
    const fixture = ${JSON.stringify({ source, tilePath, layer, secret })};
    function render() {
      return new Promise((resolve, reject) => {
        const map = new Map({
          container: 'map', center: [1, 1], zoom: 5, attributionControl: false,
          transformRequest: (url) => url === fixture.source || url.startsWith(fixture.tilePath)
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
          resolve({ features: features.map(({ properties }) => properties) });
        });
      });
    }
    for (let frame = 0; frame < ${frameCount}; frame++) {
      await report(await render());
    }`;
  return renderMapLibre({ origin, results, name, script, frameCount, afterFirstRender });
}

export async function renderMvt({ origin, source, layer, secret, results, afterFirstRender }) {
  const evidence = await renderVectorTiles({ origin, source, layer, secret, results, name: 'mvt-browser',
    frameCount: 2, afterFirstRender });
  for (const [index, label] of ['Greenwich', 'Greenwich after COMMIT'].entries()) {
    assert.ok(evidence[index].features.some((feature) => feature.id === 'row-1' && feature.label === label));
  }
}
