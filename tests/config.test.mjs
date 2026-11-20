import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { test } from 'node:test';

const valid = readFileSync('examples/features.yaml', 'utf8');
const cases = [
  ['schema-version', 'schema_version: 1', 'schema_version: 2', /schema_version/],
  ['required-field', '    title: Example places\n', '', /required property.*title/],
  ['unknown-field', '    title: Example places', '    label: Unexpected\n    title: Example places', /additional properties.*label/],
  ['source-reference', 'source: sample-places', 'source: missing-source', /unknown source 'missing-source'/],
  ['provider-reference', 'provider: file-features', 'provider: missing-provider', /unknown provider 'missing-provider'/],
];

for (const [name, original, replacement, expected] of cases) {
  test(`config validate rejects ${name}`, () => {
    assert.ok(valid.includes(original));
    const filename = `/results/${name}.yaml`;
    writeFileSync(filename, valid.replace(original, replacement));
    const result = spawnSync(process.execPath, ['dist/cli.js', 'config', 'validate', filename, '--json'], {
      encoding: 'utf8',
      timeout: 10_000,
    });
    assert.ifError(result.error);
    assert.equal(result.status, 2, result.stderr || result.stdout);
    const response = JSON.parse(result.stdout);
    assert.equal(response.status, 'error');
    assert.equal(response.code, 'INVALID_CONFIG');
    assert.match(response.data.message, expected);
  });
}

test('config validate budgets source preparation per PostGIS publication', () => {
  const yaml = valid.replace('    type: geojson\n    path: places.geojson', `    type: postgis
    schema: gis
    relation: places
    id_field: id
    geometry_field: geom
    max_lag_seconds: 60`).replace('    type: pygeoapi', `    type: pygeoapi
    postgis:
      host: postgis
      database: spatial
      user: reader
      password_file: ./password.txt`);
  const withSecondPublication = yaml + yaml.slice(yaml.indexOf('  places:\n')).replace('  places:\n', '  places-live:\n');
  const filename = '/results/postgis-freshness.yaml';
  const validate = (contents) => {
    writeFileSync(filename, contents);
    const result = spawnSync(process.execPath, ['dist/cli.js', 'config', 'validate', filename, '--json'], {
      encoding: 'utf8', timeout: 10_000,
    });
    assert.ifError(result.error);
    return { status: result.status, response: JSON.parse(result.stdout) };
  };
  assert.equal(validate(yaml).status, 0);
  const tooSlow = withSecondPublication + '    freshness:\n      max_delay_seconds: 0\n';
  const invalid = validate(tooSlow);
  assert.equal(invalid.status, 2);
  assert.match(invalid.response.data.message, /places-live.*max_lag_seconds.*max_delay_seconds/);
  assert.equal(validate(tooSlow.replace('max_lag_seconds: 60', 'max_lag_seconds: 0')).status, 0);
  assert.equal(validate(yaml.replace('max_lag_seconds: 60', 'max_lag_seconds: 61')).status, 2);
  assert.equal(validate(yaml.replace('      password_file: ./password.txt\n', '')).status, 2);
  assert.equal(validate(yaml.replace(/    postgis:[\s\S]+?(?=^publications:)/m, '')).status, 2);
  const mixed = yaml.replace('providers:\n', '  file:\n    type: geojson\n    path: places.geojson\nproviders:\n') +
    yaml.slice(yaml.indexOf('  places:\n')).replace('  places:\n', '  other-file:\n').replace('source: sample-places', 'source: file');
  const separated = validate(mixed);
  assert.equal(separated.status, 2);
  assert.match(separated.response.data.message, /file-features.*GeoJSON and PostGIS.*separate/);
});
