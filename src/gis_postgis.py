from pathlib import Path

from pygeoapi.provider.base import (
    ProviderConnectionError,
    ProviderItemNotFoundError,
)
from pygeoapi.provider.sql import PostgreSQLProvider
from sqlalchemy.exc import DataError, SQLAlchemyError


class PostGISProvider(PostgreSQLProvider):
    def __init__(self, definition):
        password_file = Path(definition["password_file"])
        password = password_file.read_text(encoding="utf-8").rstrip("\r\n")
        if not password:
            raise ProviderConnectionError("The PostGIS password file is empty.")
        data = {**definition["data"], "password": password}
        super().__init__({**definition, "data": data})

    def get(self, identifier, **kwargs):
        try:
            return super().get(identifier, **kwargs)
        except ProviderItemNotFoundError as error:
            # pygeoapi 0.24.0 also uses this exception when the SQL query fails.
            cause = error.__context__
            if isinstance(cause, SQLAlchemyError) and not isinstance(cause, DataError):
                raise ProviderConnectionError(
                    "The PostGIS source is unavailable."
                ) from error
            raise
