"""Adapt pygeoapi 0.24 MVT-proxy to the platform's WebMercatorQuad profile."""

from pygeoapi.provider.base import ProviderGenericError
from pygeoapi.provider.mvt_proxy import MVTProxyProvider
from pygeoapi.provider.tile import ProviderTileNotFoundError
from pygeoapi.util import url_join


class MartinTilesProvider(MVTProxyProvider):
    def get_tiles_service(self, *args, **kwargs):
        # The native tilesets list already advertises each configured matrix set.
        return {'links': []}

    def get_html_metadata(self, *args, **kwargs):
        metadata = super().get_html_metadata(*args, **kwargs)
        metadata['json_url'] = metadata['json_url'].replace('/metadata?f=json', '?f=json')
        return metadata

    def get_default_metadata(self, dataset, server_url, layer, tileset,
                             title, description, keywords, **kwargs):
        metadata = super().get_default_metadata(
            dataset, server_url, layer, tileset, title, description, keywords,
            **kwargs)
        for link in metadata['links']:
            if link['rel'] == 'item':
                link['templated'] = True
        metadata['links'].append({
            'href': tileset_url(server_url, dataset, tileset) + '?f=tilejson',
            'rel': 'alternate', 'type': 'application/json', 'title': 'TileJSON',
        })
        return metadata

    def get_vendor_metadata(self, dataset, server_url, layer, tileset,
                            title, description, keywords, **kwargs):
        url = tileset_url(server_url, dataset, tileset)
        return {
            'tilejson': '3.0.0', 'name': title, 'description': description,
            'scheme': 'xyz', 'tiles': [f'{url}/{{z}}/{{y}}/{{x}}?f=mvt'],
            'minzoom': self.options['zoom']['min'],
            'maxzoom': self.options['zoom']['max'],
            'vector_layers': [
                {'id': dataset, 'fields': dict.fromkeys(self.options['fields'], '')},
            ],
        }

    def get_tiles(self, layer=None, tileset=None, z=None, y=None, x=None,
                  format_=None):
        matrix, row, col = map(int, (z, y, x))
        if (not self.options['zoom']['min'] <= matrix <= self.options['zoom']['max']
                or not 0 <= row < 2 ** matrix or not 0 <= col < 2 ** matrix):
            raise ProviderTileNotFoundError
        return super().get_tiles(layer, tileset, z, y, x, format_) or None

    def is_in_limits(self, tilematrixset, z, x, y):
        # MVT-proxy calls this only for upstream 404 or 500. Bounds were
        # validated above and Martin returns 204 for tiles without data.
        raise ProviderGenericError('The publication source is unavailable.')


def tileset_url(server_url, dataset, tileset):
    return url_join(server_url, f'collections/{dataset}/tiles/{tileset}')
