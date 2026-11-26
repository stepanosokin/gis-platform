"""Validate the mounted snapshots before publishing the native OpenAPI."""

import json
import os
import sys

import duckdb
import h3


def validate_snapshot(database, source, level):
    filepath = source["filepath"]
    identifier = source["id_col"]
    indicators = source["data_cols"]
    columns = database.execute("DESCRIBE SELECT * FROM read_parquet(?)", [filepath]).fetchall()
    types = {name: dtype for name, dtype, *_ in columns}
    if set(types) != {identifier, *indicators} or types[identifier] != "VARCHAR":
        raise ValueError("expected a string H3 ID and the declared indicator columns")
    if any(types[name] not in {"TINYINT", "BIGINT", "DOUBLE"} for name in indicators):
        raise ValueError("indicator columns must use TINYINT, BIGINT, or DOUBLE to preserve their precision")
    # The stock Parquet provider reads an unquoted projection.
    projection = [identifier, *indicators]
    result = database.execute(
        f"DESCRIBE SELECT {', '.join(projection)} FROM read_parquet(?)", [filepath],
    ).fetchall()
    if [(name, dtype) for name, dtype, *_ in result] != [(name, types[name]) for name in projection]:
        raise ValueError("indicator columns must be readable by the stock projection")
    identifiers = f"SELECT {identifier} FROM read_parquet(?)"
    rows, unique_ids = database.execute(
        f"SELECT count(*), count(DISTINCT {identifier}) FROM ({identifiers})", [filepath],
    ).fetchone()
    if rows != unique_ids:
        raise ValueError("empty or duplicate H3 ID")
    cells = database.execute(identifiers, [filepath])
    while batch := cells.fetchmany(8192):
        for (cell,) in batch:
            if cell != cell.lower() or not h3.is_valid_cell(cell) or h3.get_resolution(cell) != level:
                raise ValueError("invalid H3 ID or resolution")


with open(os.environ["DGGS_API_CONFIG"], encoding="utf-8") as config_file:
    config = json.load(config_file)
sources = config["collection_providers"]["1"]["parquet"]["datasources"]
levels = {}
for record in config["collections"].values():
    collection, = record.values()
    provider = collection["collection_provider"]
    levels[provider["datasource_id"]] = provider["min_refinement_level"]
with duckdb.connect() as database:
    for key, source in sources.items():
        try:
            validate_snapshot(database, source, levels[key])
        except (ValueError, duckdb.Error):
            print(f"GIS_INVALID_DGGS_SNAPSHOT {key}", file=sys.stderr)
            raise SystemExit(1) from None

from pydggsapi.api import app

print(json.dumps(app.openapi()))
