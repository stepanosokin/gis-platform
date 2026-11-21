import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export function measureGateway(name, cases, origin, caFile) {
  const python = process.env.GIS_TEST_PYTHON;
  if (!python) return;
  const result = spawnSync(python, [
    'tests/acceptance.py', origin, '--project', process.env.COMPOSE_PROJECT_NAME,
    ...(caFile ? ['--ca-file', caFile] : []),
  ], { input: JSON.stringify(cases), encoding: 'utf8', windowsHide: true });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  writeFileSync(join(dirname(process.env.GIS_TEST_CONFIG), `acceptance-${name}.json`), result.stdout);
}
