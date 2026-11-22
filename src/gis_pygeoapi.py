"""Select a protocol for the native pygeoapi request using the gateway route."""

import json
import os
from copy import deepcopy

from flask import request
from pygeoapi import flask_app
from pygeoapi.api import API
from werkzeug.local import LocalProxy


def protocol_api(protocol, profile):
    config = deepcopy(flask_app.CONFIG)
    config['server']['url'] = profile['url']
    config['resources'] = {name: config['resources'][name] for name in profile['collections']}
    metadata = config['metadata']
    metadata['identification'].update(
        title=f"GIS Platform {profile['name']}", description=f"OGC API {profile['name']} collections",
        keywords=[protocol, 'geospatial'], url=profile['url'], terms_of_service=profile['url'],
    )
    for section in ('license', 'provider', 'contact'):
        metadata[section]['url'] = profile['url']
    return API(config, flask_app.OPENAPI, flask_app.ASYNCAPI)


profiles = json.loads(os.environ['GIS_PYGEOAPI_PROTOCOLS'])
apis = {protocol: protocol_api(protocol, profile) for protocol, profile in profiles.items()}
default_api = flask_app.api_
flask_app.api_ = LocalProxy(lambda: apis.get(request.headers.get('X-GIS-Protocol'), default_api))
APP = flask_app.APP
