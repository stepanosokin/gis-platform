-- Run in a disposable PostGIS database to reproduce the fixture boundaries.
CREATE EXTENSION IF NOT EXISTS h3_postgis CASCADE;

WITH samples (label, longitude, latitude) AS (
  VALUES ('bay', -122.418, 37.775), ('dateline', 179.98, 0), ('insert', 12, 40), ('missing', 50, 30)
), cells AS (
  SELECT label, h3_latlng_to_cell(ST_SetSRID(ST_MakePoint(longitude, latitude), 4326), 5) AS cell
  FROM samples
), boundaries AS (
  SELECT label, cell, ST_Multi(h3_cell_to_boundary_geometry(cell))::geometry(MultiPolygon, 4326) AS geom
  FROM cells
)
SELECT label, cell, h3_get_resolution(cell), ST_IsValid(geom), ST_NumGeometries(geom), ST_AsText(geom, 9)
FROM boundaries;

SELECT extname, extversion FROM pg_extension WHERE extname IN ('h3', 'h3_postgis', 'postgis');
