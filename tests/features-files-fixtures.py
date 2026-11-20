import json
from datetime import datetime, timezone

from osgeo import ogr, osr
import pyarrow as pa
import pyarrow.parquet as pq


def write(driver_name, filename):
    driver = ogr.GetDriverByName(driver_name)
    crs = osr.SpatialReference()
    crs.ImportFromEPSG(4326)
    dataset = driver.CreateDataSource(filename)
    layer = dataset.CreateLayer("places", crs)
    layer.CreateField(ogr.FieldDefn("key", ogr.OFTString))

    for key, wkt in [
        ("reference", "POINT (37.62 55.75)"),
        ("crossing", "LINESTRING (37 55.5,40 55.5)"),
    ]:
        feature = ogr.Feature(layer.GetLayerDefn())
        feature.SetField("key", key)
        feature.SetGeometry(ogr.CreateGeometryFromWkt(wkt))
        if layer.CreateFeature(feature):
            raise RuntimeError("Failed to write the test feature")

    dataset = None


write("GPKG", "/results/places.gpkg")

driver = ogr.GetDriverByName("ESRI Shapefile")
shape_file = driver.CreateDataSource("/results/places-shape.shp")
mercator = osr.SpatialReference()
mercator.ImportFromEPSG(3857)
points = shape_file.CreateLayer("places-shape", mercator, ogr.wkbPoint)
points.CreateField(ogr.FieldDefn("key", ogr.OFTString))
point = ogr.Feature(points.GetLayerDefn())
point.SetField("key", "reference")
point.SetGeometry(ogr.CreateGeometryFromWkt("POINT (4187839.243643 7508807.851302)"))
points.CreateFeature(point)
shape_file = None

geometries = [
    ogr.CreateGeometryFromWkt(wkt).ExportToIsoWkb()
    for wkt in [
        "POINT (37.62 55.75)",
        "LINESTRING (37 55.5,40 55.5)",
        "POLYGON ((38 56.2,40 56.2,40 58,38 58,38 56.2),(38.5 56.5,39.5 56.5,39.5 57.5,38.5 57.5,38.5 56.5))",
        "POINT (37.5 57)",
    ]
]
metadata = {
    "version": "1.1.0",
    "primary_column": "position",
    "columns": {"position": {"encoding": "WKB", "geometry_types": ["Point", "LineString", "Polygon"]}},
}
table = pa.table({
    "key": ["reference", "crossing", "area/with-hole", "timeless"],
    "position": list(map(bytes, geometries)),
    "observed": [datetime(2026, 1, day, tzinfo=timezone.utc) for day in (1, 2, 3)] + [None],
})
pq.write_table(table.replace_schema_metadata({b"geo": json.dumps(metadata).encode()}), "/results/places.parquet")
