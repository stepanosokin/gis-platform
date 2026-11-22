import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const rasterColors = [[255, 0, 0, 255], [0, 255, 0, 255], [0, 0, 255, 255], [255, 255, 0, 255]];

export async function assertRasterPixels(response, width, height, colors, directory, image) {
  assert.equal(response.headers.get('content-type'), 'image/png');
  const output = `map-${width}x${height}.png`;
  writeFileSync(join(directory, output), Buffer.from(await response.arrayBuffer()));
  const sample = spawnSync('docker', ['run', '--rm',
    '--mount', `type=bind,src=${directory},dst=/results,readonly`,
    '--entrypoint', '/venv/bin/python', image, '-c', `
import json
from osgeo import gdal
image = gdal.Open('/results/${output}')
points = [(x, y) for y in (2, image.RasterYSize - 3) for x in (2, image.RasterXSize - 3)]
print(json.dumps([image.RasterXSize, image.RasterYSize, [list(image.ReadRaster(x, y, 1, 1)) for x, y in points]]))
`], { encoding: 'utf8' });
  assert.ifError(sample.error);
  assert.equal(sample.status, 0, sample.stderr);
  assert.deepEqual(JSON.parse(sample.stdout), [width, height, colors]);
}
