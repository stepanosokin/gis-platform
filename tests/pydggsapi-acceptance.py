"""Generate test Parquet and check the native API of pydggsapi 0.4.0."""

import argparse
import json
import os
import shutil
import subprocess
import tempfile
import time
import unittest
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

import duckdb
import h3
from shapely import from_wkb
from shapely.geometry import Polygon, box, shape


FIXTURE = Path("/fixture")
ORIGIN = "http://127.0.0.1:8000"
PREFIX = "/dggs-api"
LEVEL = 7
SMALL_BBOX = (12.28, 45.41, 12.36, 45.47)
LARGE_BBOX = (11.8, 45.0, 12.9, 45.9)
EXACT_BIGINT = 2**53 + 1


def boundary(cell):
    return Polygon([(lon, lat) for lat, lon in h3.cell_to_boundary(cell)])


def fixtures(safe_integers):
    # Enumerate cells using a neighbor disk. Use polygon intersection as the
    # oracle for the bbox endpoint, which uses H3's overlap polyfill.
    center = h3.latlng_to_cell(45.45, 12.35, LEVEL)
    cells = {
        cell: boundary(cell)
        for cell in sorted(h3.grid_disk(center, 64))
    }
    dense = {
        cell: polygon for cell, polygon in cells.items()
        if polygon.intersects(box(*LARGE_BBOX))
    }
    small = [
        cell for cell, polygon in dense.items()
        if polygon.intersects(box(*SMALL_BBOX))
    ]
    sparse = {cell: dense[cell] for cell in small[:4] + list(dense)[::29]}
    zero, null, missing, positive = small[:4]
    sparse.pop(missing)

    collections = {}
    sources = {}
    oracle = {"zero": zero, "null": null, "missing": missing, "positive": positive, "cells": {}, "small": {}}
    tally = EXACT_BIGINT - 2 if safe_integers else EXACT_BIGINT
    with duckdb.connect() as db:
        db.execute("CREATE TABLE snapshot (h3_id VARCHAR PRIMARY KEY, tally BIGINT, metric DOUBLE)")
        for name, polygons in (("dense", dense), ("sparse", sparse)):
            rows = [
                (cell, 0, 0.0) if cell == zero else
                (cell, None, None) if cell == null else
                (cell, tally, 4.25) if cell == positive else
                (cell, 5, 4.25)
                for cell in polygons
            ]
            db.execute("DELETE FROM snapshot")
            db.executemany("INSERT INTO snapshot VALUES (?, ?, ?)", rows)
            filename = FIXTURE / f"{name}-v1.parquet"
            db.execute("COPY snapshot TO ? (FORMAT PARQUET)", [str(filename)])
            assert db.execute(
                "SELECT h3_id, tally, metric FROM read_parquet(?) ORDER BY h3_id",
                [str(filename)],
            ).fetchall() == sorted(rows)
            assert all(h3.is_valid_cell(cell) and h3.get_resolution(cell) == LEVEL for cell in polygons)
            oracle["cells"][name] = {
                cell: polygon.wkb_hex for cell, polygon in polygons.items()
            }
            oracle["small"][name] = sorted(set(small).intersection(polygons))
            if safe_integers and name == "sparse":
                db.execute("UPDATE snapshot SET tally = 9, metric = 3.5 WHERE h3_id = ?", [zero])
                db.execute("COPY snapshot TO ? (FORMAT PARQUET)", [str(FIXTURE / "sparse-v2.parquet")])
                db.execute(
                    "COPY (SELECT * FROM snapshot UNION ALL SELECT * FROM snapshot) TO ? (FORMAT PARQUET)",
                    [str(FIXTURE / "sparse-duplicate.parquet")],
                )
                db.execute(
                    "COPY (SELECT h3_id, CAST(CASE WHEN tally > 2147483647 THEN 16777217 ELSE tally END AS INTEGER) "
                    "AS tally, metric FROM snapshot) TO ? (FORMAT PARQUET)",
                    [str(FIXTURE / "sparse-int32.parquet")],
                )
                db.execute(
                    'COPY (SELECT h3_id, tally AS "select", metric FROM snapshot) TO ? (FORMAT PARQUET)',
                    [str(FIXTURE / "sparse-reserved-column.parquet")],
                )
            collections[str(len(collections) + 1)] = {name: {
                "title": f"{name.title()} H3 fixture",
                "description": "H3 resolution 7 near Venice",
                "extent": {"spatial": {"bbox": [list(LARGE_BBOX)]}},
                "collection_provider": {
                    "providerId": "parquet", "dggrsId": "h3",
                    "min_refinement_level": LEVEL, "max_refinement_level": LEVEL,
                    "datasource_id": name,
                },
            }}
            sources[name] = {
                "filepath": str(filename), "id_col": "h3_id", "data_cols": ["tally", "metric"],
            }

    config = {
        "collections": collections,
        "dggrs": {"1": {"h3": {
            "title": "H3", "description": "H3 discrete global grid", "crs": "wgs84",
            "shapeType": "hexagon", "definition_link": "https://h3geo.org/",
            "defaultDepth": 1, "classname": "h3_dggrs_provider.H3Provider",
        }}},
        "collection_providers": {"1": {"parquet": {
            "classname": "parquet_collection_provider.ParquetCollectionProvider",
            "datasources": sources,
        }}},
    }
    (FIXTURE / "config.json").write_text(json.dumps(config), encoding="utf-8")
    (FIXTURE / "oracle.json").write_text(json.dumps(oracle), encoding="utf-8")


def get(path, **params):
    url = ORIGIN + path
    if params:
        url += "?" + urlencode(params)
    try:
        response = urlopen(Request(url, headers={"Accept": "*/*"}), timeout=30)
    except HTTPError as error:
        response = error
    with response:
        payload = response.read()
        return response.status, json.loads(payload) if payload else None


def zones(collection):
    return f"{PREFIX}/collections/{collection}/dggs/h3/zones"


class NativeAPI(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.oracle = json.loads((FIXTURE / "oracle.json").read_text(encoding="utf-8"))
        cls.cells = {
            name: {cell: from_wkb(bytes.fromhex(wkb)) for cell, wkb in cells.items()}
            for name, cells in cls.oracle["cells"].items()
        }

    def test_zone_geometry(self):
        cell = self.oracle["zero"]
        status, payload = get(f"{zones('sparse')}/{cell}")
        self.assertEqual(status, 200, payload)
        self.assertEqual(payload["id"], cell)
        self.assertEqual(payload["level"], LEVEL)
        self.assertTrue(shape(payload["geometry"]).equals(self.cells["sparse"][cell]))

    def test_collection_metadata(self):
        path = f"{PREFIX}/collections/sparse"
        status, collection = get(path)
        self.assertEqual(status, 200, collection)
        self.assertEqual(collection["id"], "sparse")
        self.assertEqual(collection["title"], "Sparse H3 fixture")
        self.assertEqual(collection["description"], "H3 resolution 7 near Venice")
        self.assertEqual(collection["extent"]["spatial"]["bbox"], [list(LARGE_BBOX)])

        status, grid = get(path + "/dggs/h3")
        self.assertEqual(status, 200, grid)
        self.assertEqual(grid["id"], "h3")
        self.assertEqual(grid["maxRefinementLevel"], LEVEL)

        status, spec = get("/openapi.json")
        self.assertEqual(status, 200, spec)
        template = f"{PREFIX}/collections/{{collectionId}}/dggs/{{dggrsId}}/zones"
        for route in (template, template + "/{zoneId}", template + "/{zoneId}/data"):
            self.assertIn("get", spec["paths"][route])

    def test_zone_data(self):
        for kind, expected in (
            ("zero", (0, 0.0)),
            ("null", (None, None)),
            ("positive", (EXACT_BIGINT, 4.25)),
            ("missing", None),
        ):
            with self.subTest(kind=kind):
                cell = self.oracle[kind]
                status, payload = get(f"{zones('sparse')}/{cell}/data", **{"zone-depth": 0})
                if expected is None:
                    self.assertEqual((status, payload), (204, None))
                    continue
                self.assertEqual(status, 200, payload)
                self.assertEqual(payload["zoneId"], cell)
                self.assertEqual(payload["depths"], [0])
                self.assertEqual(
                    tuple(payload["values"][f"sparse.{name}"][0]["data"][0] for name in ("tally", "metric")),
                    expected,
                )

    def test_bbox_completeness(self):
        for collection, bbox, limit, complete in (
            ("dense", SMALL_BBOX, None, True),
            ("sparse", SMALL_BBOX, None, True),
            ("dense", LARGE_BBOX, None, False),
            ("sparse", LARGE_BBOX, None, False),
            ("dense", LARGE_BBOX, 10000, True),
            ("sparse", LARGE_BBOX, 10000, True),
        ):
            with self.subTest(collection=collection, bbox=bbox, limit=limit):
                window = box(*bbox)
                expected = {
                    cell for cell, polygon in self.cells[collection].items()
                    if polygon.intersects(window)
                }
                params = {"compact-zones": "false", "zone-level": LEVEL}
                if limit is not None:
                    params["limit"] = limit
                status, payload = get(
                    zones(collection), bbox=",".join(map(str, bbox)),
                    f="geojson", geometry="zone-region", **params,
                )
                self.assertEqual(status, 200, payload)
                features = payload["features"]
                observed = {feature["properties"]["zoneId"] for feature in features}
                missing, unexpected = expected - observed, observed - expected
                print(f"{collection} {bbox} limit={limit}: expected {len(expected)}, got {len(features)}", flush=True)
                self.assertEqual(len(features), len(observed))
                self.assertEqual(len(unexpected), 0)
                if complete:
                    self.assertEqual(len(missing), 0, f"First missing H3 ID: {min(missing, default='none')}")
                else:
                    self.assertGreater(len(missing), 0)
                for feature in features:
                    polygon = self.cells[collection][feature["properties"]["zoneId"]]
                    self.assertTrue(shape(feature["geometry"]).equals(polygon))


def check():
    # TinyDB opens its configuration for writing. The snapshots stay mounted
    # read-only while the native process uses a disposable copy of the config.
    with tempfile.TemporaryDirectory() as directory:
        config = shutil.copyfile(FIXTURE / "config.json", Path(directory) / "config.json")
        return check_server(config)


def check_server(config):
    with subprocess.Popen([
        "uvicorn", "pydggsapi.api:app", "--host", "127.0.0.1", "--port", "8000",
    ], env={**os.environ, "DGGS_API_CONFIG": config}) as server:
        try:
            for _ in range(100):
                if server.poll() is not None:
                    raise RuntimeError(f"pydggsapi exited with status {server.returncode}")
                try:
                    if get(f"{PREFIX}/collections")[0] == 200:
                        break
                except URLError:
                    pass
                time.sleep(0.2)
            else:
                raise RuntimeError("pydggsapi did not start")
            return unittest.TextTestRunner(verbosity=2).run(
                unittest.defaultTestLoader.loadTestsFromTestCase(NativeAPI)
            ).wasSuccessful()
        finally:
            server.terminate()


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("action", choices=["fixtures", "check"])
    parser.add_argument("--safe-integers", action="store_true")
    arguments = parser.parse_args()
    if arguments.action == "fixtures":
        fixtures(arguments.safe_integers)
    else:
        raise SystemExit(0 if check() else 1)
