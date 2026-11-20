from contextlib import contextmanager
from datetime import timezone
import json
from math import isfinite

from dateutil.parser import isoparse
import fiona
from flask import has_request_context, request
from pygeoapi.crs import DEFAULT_CRS, crs_transform, get_crs, get_transform_from_crs
from pygeoapi.provider.base import (
    BaseProvider,
    ProviderConnectionError,
    ProviderInvalidQueryError,
    ProviderItemNotFoundError,
)
from pyproj import CRS
from shapely import from_wkb
from shapely.geometry import LineString, Point, box, mapping, shape
from shapely.ops import unary_union


class VectorFileProvider(BaseProvider):
    def __init__(self, definition):
        super().__init__(definition)
        self.layer = definition.get("layer")
        self.is_parquet = self.data["driver"] == "Parquet"
        with self.open_source() as source:
            if self.is_parquet:
                self._fields = source.fields
                crs = source.crs
            else:
                self._fields = {
                    name: field_schema(kind.split(":")[0])
                    for name, kind in source.schema["properties"].items()
                }
                if not source.crs_wkt:
                    raise ProviderConnectionError("The file layer must declare its CRS.")
                crs = CRS.from_wkt(source.crs_wkt)
            if self._fields.get(self.id_field, {}).get("type") not in ("string", "integer"):
                raise ProviderConnectionError("id_field must be a string or integer field in the layer.")
            if self.time_field and self._fields.get(self.time_field, {}).get("format") != "date-time":
                raise ProviderConnectionError("GeoParquet time_field must reference a timestamp column.")
            self.to_crs84 = get_transform_from_crs(
                crs, get_crs(DEFAULT_CRS), always_xy=True
            )

    @contextmanager
    def open_source(self):
        if self.is_parquet:
            try:
                from pyarrow.parquet import ParquetFile

                with ParquetFile(self.data["path"]) as file:
                    yield GeoParquetSource(file)
            except (ImportError, OSError, ValueError) as error:
                raise ProviderConnectionError("The GeoParquet file requires a reader, valid CRS and WKB geometry.") from error
            return
        try:
            with fiona.open(self.data["path"], layer=self.layer,
                            enabled_drivers=[self.data["driver"]]) as source:
                yield source
        except (ValueError, fiona.errors.FionaError) as error:
            raise ProviderConnectionError("The configured file or layer is unavailable.") from error

    def get_fields(self):
        return self._fields

    def _records(self, source):
        if self.is_parquet:
            yield from source
        else:
            for row in source:
                yield dict(row.properties), shape(row.geometry) if row.geometry is not None else None

    def _feature(self, properties, geometry, select_properties=()):
        return {
            "type": "Feature",
            "id": properties[self.id_field],
            "geometry": mapping(geometry) if geometry is not None else None,
            "properties": {name: properties[name] for name in select_properties} if select_properties else properties,
        }

    @crs_transform
    def get(self, identifier, **kwargs):
        with self.open_source() as source:
            for properties, geometry in self._records(source):
                if str(properties[self.id_field]) == identifier:
                    return self._feature(properties, self.to_crs84(geometry) if geometry is not None else None)
        raise ProviderItemNotFoundError("The feature ID was not found.")

    @crs_transform
    def query(self, offset=0, limit=10, resulttype="results", bbox=None, datetime_=None,
              properties=(), sortby=(), select_properties=(), skip_geometry=False,
              filterq=None, **kwargs):
        if filterq is not None or sortby:
            raise ProviderInvalidQueryError(user_msg="This file publication does not support CQL2 or sortby.")
        if datetime_ and not self.time_field:
            raise ProviderInvalidQueryError(user_msg="This file publication does not support datetime.")
        time_bounds = datetime_bounds(datetime_) if datetime_ else None
        bounds, to_bbox_crs = spatial_filter(bbox)
        features = []
        matched = 0
        with self.open_source() as source:
            for row, geometry in self._records(source):
                if any(str(row.get(key)) != value for key, value in properties):
                    continue
                if time_bounds and not datetime_matches(row[self.time_field], *time_bounds):
                    continue
                normalized = None
                if bounds is not None and geometry is not None:
                    normalized = self.to_crs84(geometry)
                    if not to_bbox_crs(normalized).intersects(bounds):
                        continue
                matched += 1
                if resulttype == "hits" or not offset < matched <= offset + limit:
                    continue
                output = None
                if geometry is not None and not skip_geometry:
                    output = normalized if normalized is not None else self.to_crs84(geometry)
                features.append(self._feature(row, output, select_properties))
        return {
            "type": "FeatureCollection", "features": features,
            "numberMatched": matched, "numberReturned": len(features),
        }

    def validate_source(self):
        identifiers = set()
        with self.open_source() as source:
            for properties, geometry in self._records(source):
                identifier = properties[self.id_field]
                if type(identifier) not in (str, int) or identifier == "" or identifier in identifiers:
                    raise ProviderConnectionError("id_field must contain unique, non-empty values.")
                identifiers.add(identifier)
                if geometry is not None:
                    self.to_crs84(geometry)


class GeoParquetSource:
    def __init__(self, file):
        from pyarrow import types

        self.file = file
        schema = self.file.schema_arrow
        try:
            metadata = json.loads((schema.metadata or {})[b"geo"])
            self.geometry_column = metadata["primary_column"]
            geometry = metadata["columns"][self.geometry_column]
            encoding = geometry["encoding"]
            field = schema.field(self.geometry_column)
        except (KeyError, TypeError) as error:
            raise ValueError("Missing GeoParquet geometry metadata.") from error
        if encoding != "WKB" or not (types.is_binary(field.type) or types.is_large_binary(field.type)):
            raise ValueError("The GeoParquet primary geometry must use WKB.")
        if geometry.get("edges", "planar") != "planar":
            raise ValueError("The GeoParquet primary geometry must use planar edges.")
        self.crs = CRS.from_user_input(geometry.get("crs", "OGC:CRS84"))
        geometry_columns = metadata["columns"]
        self.fields = {
            field.name: field_schema(str(field.type))
            for field in schema if field.name not in geometry_columns
        }
        self.columns = [*self.fields, self.geometry_column]

    def __iter__(self):
        for batch in self.file.iter_batches(columns=self.columns, batch_size=4096):
            for properties in batch.to_pylist():
                binary = properties.pop(self.geometry_column)
                yield properties, from_wkb(binary) if binary is not None else None


def field_schema(name):
    if name.startswith(("int", "uint")):
        return {"type": "integer"}
    if name.startswith("float") or name == "double":
        return {"type": "number"}
    if name == "bool":
        return {"type": "boolean"}
    if name.startswith("timestamp"):
        return {"type": "string", "format": "date-time"}
    if name.startswith("list"):
        return {"type": "array"}
    if name.startswith(("struct", "map")):
        return {"type": "object"}
    return {"type": "string"}


def datetime_bounds(value):
    start, separator, end = value.partition("/")
    return tuple(as_utc(isoparse(bound)) if bound and bound != ".." else None
                 for bound in (start, end if separator else start))


def as_utc(value):
    return value.replace(tzinfo=timezone.utc) if value.tzinfo is None else value


def datetime_matches(value, start, end):
    if value is None:
        return True
    value = as_utc(value)
    return (start is None or value >= start) and (end is None or value <= end)


def spatial_filter(bbox):
    if not bbox:
        return None, None
    crs = DEFAULT_CRS
    if has_request_context():
        # pygeoapi passes only two projected corners to providers. Evaluate
        # intersection in the requested CRS to keep nonlinear bbox edges.
        crs = request.args.get("bbox-crs", DEFAULT_CRS)
        bbox = [float(value) for value in request.args["bbox"].split(",")]
    if len(bbox) != 4 or not all(map(isfinite, bbox)):
        raise ProviderInvalidQueryError(user_msg="bbox requires four finite coordinates for these two-dimensional CRSs.")
    west, south, east, north = bbox
    if west > east:
        if crs != DEFAULT_CRS:
            raise ProviderInvalidQueryError(user_msg="The lower bbox coordinate must precede the upper coordinate.")
        bounds = unary_union([box(west, south, 180, north), box(-180, south, east, north)])
    elif west == east and south == north:
        bounds = Point(west, south)
    elif west == east or south == north:
        bounds = LineString([(west, south), (east, north)])
    else:
        bounds = box(*bbox)
    transform = get_transform_from_crs(get_crs(DEFAULT_CRS), get_crs(crs)) if crs != DEFAULT_CRS else lambda item: item
    return bounds, transform
