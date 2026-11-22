import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

const valid = readFileSync('examples/features.yaml', 'utf8');
const results = process.env.GIS_TEST_RESULTS ?? '/results';
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
    const filename = join(results, `${name}.yaml`);
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

test('config validate accepts named PostGIS sources alongside files and budgets source preparation per publication', () => {
  const yaml = valid.replace('    type: geojson\n    path: places.geojson', `    type: postgis
    connection: live
    schema: gis
    relation: places
    id_field: id
    geometry_field: geom
    max_lag_seconds: 60`).replace('sources:', `postgis_connections:
  live:
    host: postgis
    database: spatial
    user: reader
    password_file: ./password.txt
  archive:
    host: archive
    database: historical
    user: reader
    password_file: ./archive-password.txt
sources:`);
  const withSecondPublication = yaml + yaml.slice(yaml.indexOf('  places:\n')).replace('  places:\n', '  places-live:\n');
  const filename = join(results, 'postgis-freshness.yaml');
  const validate = (contents) => {
    writeFileSync(filename, contents);
    const result = spawnSync(process.execPath, ['dist/cli.js', 'config', 'validate', filename, '--json'], {
      encoding: 'utf8', timeout: 10_000,
    });
    assert.ifError(result.error);
    return { status: result.status, response: JSON.parse(result.stdout) };
  };
  const result = validate(yaml);
  assert.equal(result.status, 0, result.response.data?.message);
  const tooSlow = withSecondPublication + '    freshness:\n      max_delay_seconds: 0\n';
  const invalid = validate(tooSlow);
  assert.equal(invalid.status, 2);
  assert.match(invalid.response.data.message, /places-live.*max_lag_seconds.*max_delay_seconds/);
  assert.equal(validate(tooSlow.replace('max_lag_seconds: 60', 'max_lag_seconds: 0')).status, 0);
  assert.equal(validate(yaml.replace('max_lag_seconds: 60', 'max_lag_seconds: 61')).status, 2);
  assert.equal(validate(yaml.replace('    password_file: ./password.txt\n', '')).status, 2);
  assert.equal(validate(yaml.replace('    connection: live\n', '')).status, 2);
  assert.match(validate(yaml.replace('connection: live', 'connection: absent')).response.data.message,
    /sample-places.*unknown PostGIS connection 'absent'/);
  const mixed = yaml.replace('providers:\n', `  file:
    type: geojson
    path: places.geojson
  historical-places:
    type: postgis
    connection: archive
    schema: gis
    relation: places
    id_field: id
    geometry_field: geom
    max_lag_seconds: 0
providers:
`) + yaml.slice(yaml.indexOf('  places:\n')).replace('  places:\n', '  other-file:\n').replace('source: sample-places', 'source: file')
    + yaml.slice(yaml.indexOf('  places:\n')).replace('  places:\n', '  historical:\n').replace('source: sample-places', 'source: historical-places');
  assert.equal(validate(mixed).status, 0);
  const namedVolume = yaml.replace('    type: pygeoapi\n', `    type: pygeoapi
    image: geopython/pygeoapi:0.24.0
    api: {protocol: features, scheme: http, port: 80, base_path: /, public_root: /features, links: canonical, readiness: /openapi}
    volumes:
      state: /run/secrets/postgis-archive
`);
  assert.equal(validate(namedVolume).status, 0);
  assert.match(validate(namedVolume.replace('postgis-archive', 'postgis-live')).response.data.message, /Invalid volume targets/);
  const legacy = yaml.replace('    type: pygeoapi\n', '    type: pygeoapi\n    postgis: {}\n');
  assert.match(validate(legacy).response.data.message, /providers\.file-features\.postgis.*postgis_connections/);
});
