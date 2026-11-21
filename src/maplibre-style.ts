import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { publicationEntries, publicationUrl, type FeaturesConfig } from './config.js';

export const mapLibreAssetRoute =
  '(?:style\\.json|resources/(?:[A-Za-z0-9_-]+(?:[\\x20,][A-Za-z0-9_-]+)*/)*[A-Za-z0-9_-]+(?:@2x)?\\.[a-z0-9]+)';
const assetDirectory = 'maplibre';

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function canonicalStyle(body: Buffer, url: string, files: Record<string, string>) {
  const style: unknown = JSON.parse(body.toString('utf8'));
  if (!object(style) || style.version !== 8 || !object(style.sources) || !Array.isArray(style.layers)) {
    throw new Error('Expected a MapLibre style with version 8, sources and layers.');
  }
  const base = `${url}/style.json`;
  const resourceRoot = `${url}/resources/`;
  function resource(value: unknown, kind: 'file' | 'tilejson' | 'sprite' | 'glyphs') {
    if (typeof value !== 'string' || !value.trim()) throw new Error('Expected a URL in the MapLibre style.');
    const address = new URL(value, base).href;
    if (kind === 'tilejson') {
      if (address === url || address === `${url}/`) return url;
      throw new Error('MapLibre TileJSON URLs must reference this publication.');
    }
    if (!address.startsWith(resourceRoot)) {
      throw new Error('MapLibre style URLs must reference this publication or its declared resources.');
    }
    const key = decodeURIComponent(address.slice(resourceRoot.length));
    if (kind === 'glyphs') {
      const template = '{fontstack}/{range}.pbf';
      const prefix = key.slice(0, -template.length);
      if (key.endsWith(template) && Object.keys(files).some((file) =>
        file.startsWith(prefix) && /^[^/]+\/\d+-\d+\.pbf$/.test(file.slice(prefix.length)))) {
        return new URL(prefix, resourceRoot).href + template;
      }
    } else if (kind === 'sprite') {
      if (Object.hasOwn(files, `${key}.json`) && Object.hasOwn(files, `${key}.png`) &&
          Object.hasOwn(files, `${key}@2x.json`) === Object.hasOwn(files, `${key}@2x.png`)) {
        return new URL(key, resourceRoot).href;
      }
    } else if (Object.hasOwn(files, key)) {
      return new URL(key, resourceRoot).href;
    }
    throw new Error('A MapLibre style URL references an undeclared resource.');
  }
  for (const source of Object.values(style.sources)) {
    if (!object(source)) throw new Error('Expected a MapLibre source object.');
    if (source.url !== undefined) source.url = resource(source.url, source.type === 'image' ? 'file' : 'tilejson');
    if (typeof source.data === 'string') source.data = resource(source.data, 'file');
    for (const field of ['tiles', 'urls']) {
      if (source[field] === undefined) continue;
      const values = source[field];
      if (!Array.isArray(values)) throw new Error(`Expected an array of URLs in MapLibre source ${field}.`);
      source[field] = values.map((value) => resource(value, 'file'));
    }
  }
  if (Array.isArray(style.sprite)) {
    style.sprite = style.sprite.map((sprite: unknown) => {
      if (!object(sprite)) throw new Error('Expected a MapLibre sprite object.');
      return { ...sprite, url: resource(sprite.url, 'sprite') };
    });
  } else if (style.sprite !== undefined) {
    style.sprite = resource(style.sprite, 'sprite');
  }
  if (style.glyphs !== undefined) style.glyphs = resource(style.glyphs, 'glyphs');
  const fontFaces = style['font-faces'];
  if (fontFaces !== undefined) {
    if (!object(fontFaces)) throw new Error('Expected a MapLibre font-faces object.');
    for (const [name, faces] of Object.entries(fontFaces)) {
      fontFaces[name] = Array.isArray(faces) ? faces.map((face: unknown) => {
        if (!object(face)) throw new Error('Expected a MapLibre font descriptor.');
        return { ...face, url: resource(face.url, 'file') };
      }) : resource(faces, 'file');
    }
  }
  return Buffer.from(JSON.stringify(style));
}

const reservedFileName = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;

function checkResourceNames(names: string[]) {
  const seen = new Map<string, string>();
  for (const name of names) {
    let path = '';
    for (const part of name.split('/')) {
      if (reservedFileName.test(part)) {
        throw new Error(`MapLibre resource path '${name}' uses a reserved file name.`);
      }
      path = path ? `${path}/${part}` : part;
      const normalized = path.toLowerCase();
      const other = seen.get(normalized);
      if (other && other !== path) throw new Error(`MapLibre resource paths '${path}' and '${other}' differ only in case.`);
      seen.set(normalized, path);
    }
  }
}

export async function mapLibreFiles(config: FeaturesConfig, archivedRevision?: string) {
  const files = new Map<string, Buffer>();
  for (const [id, publication] of publicationEntries(config)) {
    const { maplibre } = publication;
    if (!maplibre) continue;
    const url = publicationUrl(config, id, publication);
    const path = new URL(url).pathname.slice(1);
    const resources = maplibre.resources ?? {};
    const stylePath = `${path}/style.json`;
    try {
      if (reservedFileName.test(id)) throw new Error('MapLibre resources require a publication ID usable as a file name.');
      checkResourceNames(Object.keys(resources));
      files.set(stylePath, archivedRevision ? await readFile(join(archivedRevision, assetDirectory, stylePath)) :
        canonicalStyle(await readFile(maplibre.style_file), url, resources));
      for (const [name, filename] of Object.entries(resources)) {
        const resourcePath = `${path}/resources/${name}`;
        files.set(resourcePath, await readFile(archivedRevision
          ? join(archivedRevision, assetDirectory, resourcePath) : filename));
      }
    } catch (error) {
      throw new Error(`Publication '${id}': ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return files;
}

export function mapLibreHashes(files: Map<string, Buffer>) {
  if (files.size) return Object.fromEntries([...files].map(([path, data]) =>
    [path, createHash('sha256').update(data).digest('hex')]));
}

export async function writeMapLibreFiles(directory: string, files: Map<string, Buffer>) {
  for (const [path, data] of files) {
    const destination = join(directory, assetDirectory, path);
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
    await writeFile(destination, data);
  }
}
