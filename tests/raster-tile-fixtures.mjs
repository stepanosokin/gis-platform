import { writeFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { crc32, deflateSync, gzipSync } from 'node:zlib';

function pngChunk(type, data) {
  const chunk = Buffer.alloc(12 + data.length);
  chunk.writeUInt32BE(data.length);
  chunk.write(type, 4);
  data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(chunk.subarray(4, -4)), chunk.length - 4);
  return chunk;
}

export function solidPng(color) {
  const size = 256;
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header.set([8, 2], 8); // 8-bit RGB
  const row = Buffer.alloc(1 + size * 3);
  row.fill(Buffer.from(color), 1);
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(Buffer.concat(Array(size).fill(row)))), pngChunk('IEND', Buffer.alloc(0))]);
}

export function writeMbtiles(path, tile, vectorLayers) {
  using database = new DatabaseSync(path);
  database.exec(`CREATE TABLE metadata (name TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE tiles (zoom_level INTEGER, tile_column INTEGER, tile_row INTEGER, tile_data BLOB,
      PRIMARY KEY (zoom_level, tile_column, tile_row));
    INSERT INTO metadata VALUES ('name','Red control'), ('format','png'), ('type','baselayer'), ('version','1'),
      ('bounds','-180,-85,180,85'), ('minzoom','0'), ('maxzoom','0');`);
  if (vectorLayers) {
    database.exec("UPDATE metadata SET value = 'pbf' WHERE name = 'format'");
    database.prepare("INSERT INTO metadata VALUES ('json', ?)").run(JSON.stringify({ vector_layers: vectorLayers }));
  }
  database.prepare('INSERT INTO tiles VALUES (0,0,0,?)').run(vectorLayers ? gzipSync(tile) : tile);
}

export async function writePmtiles(path, tile, vectorLayers) {
  // PMTiles v3, one root entry for z/x/y 0/0/0. Test fixture sizes fit in at most two varint bytes.
  const length = tile.length < 128 ? [tile.length] : [(tile.length & 127) | 128, tile.length >> 7];
  const root = gzipSync(Buffer.from([1, 0, 1, ...length, 1]));
  const metadata = gzipSync(Buffer.from(JSON.stringify(vectorLayers
    ? { vector_layers: vectorLayers }
    : { name: 'Blue control', attribution: 'Raster fixtures' })));
  const header = Buffer.alloc(127);
  header.write('PMTiles');
  header[7] = 3;
  const metadataOffset = header.length + root.length;
  const tileOffset = metadataOffset + metadata.length;
  const fields = [header.length, root.length, metadataOffset, metadata.length, tileOffset, 0, tileOffset, tile.length, 1, 1, 1];
  for (const [index, field] of fields.entries()) header.writeBigUInt64LE(BigInt(field), 8 + index * 8);
  header.set([1, 2, 1, vectorLayers ? 1 : 2], 96); // Clustered, gzip directories, uncompressed tiles, MVT or PNG.
  for (const [index, degrees] of [-180, -85, 180, 85].entries()) header.writeInt32LE(degrees * 10_000_000, 102 + index * 4);
  await writeFile(path, Buffer.concat([header, root, metadata, tile]));
}
