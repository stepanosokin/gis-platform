import { postgisSource, type FeaturesConfig, type Publication } from './config.js';

const spec = (name: string, classes: string[], scheme = 'http') =>
  classes.map((value) => `${scheme}://www.opengis.net/spec/${name}/1.0/conf/${value}`);

export function featuresConformance(postgis: boolean) {
  return [
    ...spec('ogcapi-features-1', ['core', 'oas30', 'html', 'geojson']),
    ...spec('ogcapi-features-2', ['crs']),
    ...spec('ogcapi-features-3', ['queryables', 'queryables-query-parameters']),
    ...(postgis ? spec('cql2', ['basic-cql2', 'cql2-text', 'cql2-json']) : []),
  ];
}

export function protocolConformance(config: FeaturesConfig, protocol: Publication['protocol'],
  publications: [string, Publication][]) {
  const scheme = protocol === 'dggs' ? 'https' : 'http';
  const common = [
    ...spec('ogcapi-common-1', ['core', 'landing-page', 'json', ...(protocol === 'dggs' ? [] : ['html', 'oas30'])], scheme),
    ...spec('ogcapi-common-2', ['collections'], scheme),
  ];
  const classes = {
    maps: spec('ogcapi-maps-1', ['core']),
    tiles: spec('ogcapi-tiles-1', ['core', 'mvt', 'tileset', 'tilesets-list', 'oas30', 'geodata-tilesets']),
    dggs: spec('ogcapi-dggs-1', ['core', 'collection-dggs', 'zone-query', 'zone-geojson', 'data-retrieval', 'data-json'], scheme),
  };
  if (protocol === 'mvt') return undefined;
  return { common, publications: Object.fromEntries(publications.map(([id, publication]) => [id,
    protocol === 'features' ? featuresConformance(Boolean(postgisSource(config, publication.source))) : classes[protocol],
  ])) };
}
