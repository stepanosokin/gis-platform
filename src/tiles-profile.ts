import { postgisSource, providerServiceName, type FeaturesConfig, type Publication } from './config.js';

export const tilesRelation = 'http://www.opengis.net/def/rel/ogc/1.0/tilesets-vector';
export const matrixSet = 'WebMercatorQuad';
export const vectorTileType = 'application/vnd.mapbox-vector-tile';
export const tilesPlugin = 'gis_tiles.MartinTilesProvider';

export function tilesSource(config: FeaturesConfig, publication: Publication, id: string) {
  const rendererId = publication.tile_provider;
  const renderer = rendererId && config.providers?.[rendererId];
  const source = postgisSource(config, publication.source);
  if (!renderer || renderer.type !== 'martin' || !source) {
    throw new Error(`Publication '${id}' requires a PostGIS source on a Martin instance.`);
  }
  const { port, base_path } = renderer.api;
  const base = base_path === '/' ? '' : base_path;
  return {
    type: 'tile', name: tilesPlugin,
    data: `http://${providerServiceName(config, rendererId)}:${port}${base}/${id}/{z}/{x}/{y}`,
    options: { schemes: [matrixSet], zoom: { min: 0, max: 24 }, fields: [source.id_field, ...publication.mvt_properties ?? []] },
    format: { name: 'mvt', mimetype: vectorTileType },
  };
}

export const tilesRoutes = `tiles(/${matrixSet}(/[0-9]{1,2}/[0-9]{1,10}/[0-9]{1,10})?)?`;
