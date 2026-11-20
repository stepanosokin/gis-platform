import type { Request, Response } from 'express';

export const mapSize = { minimum: 1, maximum: 2048, width: 500, height: 300 };
export const mapRelation = 'http://www.opengis.net/def/rel/ogc/1.0/map';
export const mapBboxDescription = 'Four increasing CRS84 bounds: west,south,east,north.';

const dimensions = new Set(['width', 'height']);
const decimal = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;

function validBbox(value: string) {
  const bounds = value.split(',');
  if (bounds.length !== 4 || !bounds.every((part) => decimal.test(part))) return false;
  const [west, south, east, north] = bounds.map(Number) as [number, number, number, number];
  return west >= -180 && west < east && east <= 180 && south >= -90 && south < north && north <= 90;
}

function validateQuery(query: URLSearchParams) {
  for (const [name, value] of query) {
    if (query.getAll(name).length > 1) return `${name} must appear at most once.`;
    if (dimensions.has(name)) {
      const pixels = Number(value);
      if (!/^\d+$/.test(value) || pixels < mapSize.minimum || pixels > mapSize.maximum) {
        return `${name} must be an integer from ${mapSize.minimum} to ${mapSize.maximum}.`;
      }
    } else if (name === 'bbox') {
      if (!validBbox(value)) return `bbox must contain four increasing bounds within CRS84.`;
    } else if (name === 'f') {
      if (value !== 'png') return 'f must be png.';
    } else {
      return 'Use bbox, width, height or f to request a PNG map.';
    }
  }
}

export function validateMapRequest(req: Request, res: Response) {
  const original = req.get('X-Forwarded-Uri') ?? '';
  const separator = original.indexOf('?');
  const query = new URLSearchParams(separator < 0 ? '' : original.slice(separator + 1));
  const description = validateQuery(query);
  if (description) return res.status(400).json({ code: 'InvalidParameterValue', description });
  return res.sendStatus(204);
}
