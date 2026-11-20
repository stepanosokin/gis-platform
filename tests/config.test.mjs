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
