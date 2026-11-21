import assert from 'node:assert/strict';
import { renderMapLibre } from './maplibre-browser.mjs';

export async function renderMvt({ origin, source, layer, secret, results, afterFirstRender }) {
  const script = `
    const fixture = ${JSON.stringify({ source, layer, secret })};
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
          resolve({ features: features.map(({ properties }) => properties) });
        });
      });
    }
    await report(await render());
    await report(await render());`;
  const evidence = await renderMapLibre({ origin, results, name: 'mvt-browser', script, frameCount: 2, afterFirstRender });
  for (const [index, label] of ['Greenwich', 'Greenwich after COMMIT'].entries()) {
    assert.ok(evidence[index].features.some((feature) => feature.id === 'row-1' && feature.label === label));
  }
}
