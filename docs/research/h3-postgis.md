# Динамический PostGIS и публикация H3

Дата исследования: 2026-11-17. Задача: [Проверить динамический PostGIS и публикацию DGGS H3](https://github.com/stepanosokin/gis-platform/issues/3). Это документальное исследование, без запуска сервисов, установки расширений, подключения к внешним БД и измерений производительности. Возможности, подтверждённые документацией и исходниками, ниже отделены от предложений и будущих проверок.

Исходные ограничения проекта: обязательное ядро — pygeoapi и Martin в Docker; внешние PostgreSQL/PostGIS доступны платформе только для чтения. Расширения, схемы, индексы и функции устанавливает DBA. Общая конфигурация, gateway и редактирование Features не проектируются здесь. Изменения INSERT/UPDATE/DELETE выполняет владелец источника; сервисы должны показывать их через обычные запросы без специального ручного обновления.

## Вывод

**Предложение:** публиковать H3 сначала как обычные объекты с полями `h3_id`, `resolution`, показателями и полигональной геометрией: через OGC API Features в pygeoapi и MVT в Martin. Основание: pygeoapi имеет PostgreSQL feature provider, Martin вызывает PostGIS table/function sources, а h3_postgis превращает ячейку в геометрию. Этот маршрут технически обоснован, но ещё не проверен на сборке проекта. [pygeoapi](https://docs.pygeoapi.io/en/stable/publishing/ogcapi-features.html#postgresql), [Martin](https://maplibre.org/martin/sources-pg-functions/), [h3_postgis 4.5.0](https://github.com/postgis/h3-pg/blob/v4.5.0/h3_postgis/sql/install/01-indexing.sql).

**Ограничение:** такая публикация сама по себе не реализует OGC API DGGS. Стандарт имеет отдельные ресурсы DGGRS, zones и zone data; официальный workshop pygeoapi обозначает DGGS как Planned. Поэтому соответствие DGGS нельзя заявлять только на основании поля с H3 ID и полигонов. [OGC DGGS overview](https://ogcapi.ogc.org/dggs/overview.html), [статус pygeoapi](https://dive.pygeoapi.io/standards/).

## Версии и совместимость

| Компонент | Что подтверждено | Практическое следствие |
| --- | --- | --- |
| h3-pg | Последний стабильный релиз в проверенном списке — v4.5.0 от 2026-06-08; проект теперь в `postgis/h3-pg`. [Release](https://github.com/postgis/h3-pg/releases/tag/v4.5.0) | Старые ссылки на zachasme не использовать как основной источник обновлений. |
| H3 core | В исходнике h3-pg v4.5.0 закреплён H3 core 4.5.0. [CMake](https://github.com/postgis/h3-pg/blob/v4.5.0/CMakeLists.txt) | Совпадение версии core с версией расширения здесь проверено; не считать его общим правилом для всех релизов. |
| PostgreSQL | README 4.5.0 сообщает CI для PostgreSQL 14–18 на Linux/macOS. Это диапазон CI, а не доказательство работы с любой сборкой PostGIS. [README](https://pgxn.org/dist/h3/4.5.0/README.html) | Конкретные PostgreSQL, PostGIS, ОС и пакеты должен подтвердить DBA. |
| h3_postgis | Сборка 4.5.0 требует расширения `h3`, `postgis`, **`postgis_raster`**, даже если сценарий использует только векторные данные. [CMake h3_postgis](https://github.com/postgis/h3-pg/blob/v4.5.0/h3_postgis/CMakeLists.txt) | Нельзя предполагать, что наличия одного PostGIS достаточно. |
| pygeoapi | Stable документация — 0.24.0; latest — 0.25.dev0. [Stable](https://docs.pygeoapi.io/en/stable/publishing/ogcapi-features.html), [latest](https://docs.pygeoapi.io/en/latest/) | Для вывода о запросах ниже исследован тег 0.24.0. |
| Martin | GitHub помечает martin-v1.16.1 как Latest; текущая документация уже содержит миграцию на 2.0. [Release](https://github.com/maplibre/martin/releases/tag/martin-v1.16.1), [migration](https://maplibre.org/martin/migration-guide/) | Нельзя брать новые настройки/минимальные версии БД из main как подтверждённые для stable. |

В h3-pg 4.5.0 исправлены comparator B-tree с автоматическим переиндексированием при upgrade, ошибки SP-GiST, wrapper-функции для PostgreSQL 17+ с ограниченным search_path и проблемы геометрии на швах/низких zoom. GiST для h3index добавлен как experimental. **Предложение:** рассматривать 4.5.0 первым кандидатом, а переход с предыдущего расширения отдельно поручить DBA: это изменение БД, включая индексы. Наличие релиза не подтверждает наличие пакета в выбранном Docker-образе. [Release notes](https://github.com/postgis/h3-pg/releases/tag/v4.5.0).

## Типы, функции, геометрия и индексы

`h3` определяет `h3index`: 64-битное представление объекта H3 с шестнадцатеричным текстовым выводом. Объектом может быть ячейка, ребро или вершина; тип сам по себе не гарантирует, что это ячейка. Имена C API в SQL получают префикс `h3_` и snake_case. [Определение типа](https://github.com/postgis/h3-pg/blob/v4.5.0/h3/sql/install/00-type.sql).

Основные операции: `h3_latlng_to_cell`, `h3_get_resolution`, `h3_is_valid_cell`, `h3_cell_to_parent`, `h3_cell_to_children`, `h3_grid_disk`, `h3_polygon_to_cells`, `h3_compact_cells` и обратное разворачивание. Уровни H3 — 0–15; на каждом уровне есть 12 пятиугольников. Разрешение H3 не совпадает с XYZ zoom. [API](https://pgxn.org/dist/h3/docs/api.html), [устройство H3](https://h3geo.org/docs/core-library/overview/).

PostGIS overload `h3_latlng_to_cell(geometry, integer)` принимает координаты lon/lat SRID 4326; он не перепроецирует исходную геометрию. `h3_cell_to_geometry` возвращает центр, а `h3_cell_to_boundary_geometry` — границу ячейки и разделяет её при пересечении 180-го меридиана. В 4.5.0 есть `h3_get_resolution_from_tile_zoom` с ограничениями min/max и размером ячейки в пикселях. **Предложение:** явно использовать boundary-функцию для полигонов, заранее преобразовывать входную CRS и задавать политику resolution/zoom в конфигурации слоя. [SQL 4.5.0](https://github.com/postgis/h3-pg/blob/v4.5.0/h3_postgis/sql/install/01-indexing.sql).

Для покрытия полигона обычный `polygonToCells` отбирает ячейки по центрам. Experimental-вариант поддерживает center/full/overlap/bbox-overlap; это разные семантики покрытия. PostGIS wrappers ожидают валидные полигоны 4326; исходники отдельно предупреждают о неопределённом результате для невалидных полигонов. **Предложение:** согласовать правило включения граничных ячеек; не выбирать experimental по умолчанию ради удобства. [H3 regions](https://h3geo.org/docs/api/regions/), [PostGIS wrappers](https://github.com/postgis/h3-pg/blob/v4.5.0/h3_postgis/sql/install/05-regions.sql).

Для h3index определён стандартный B-tree operator class; для геометрического bbox/пересечения PostGIS имеет пространственные индексы. Это разные задачи. **Предложение:** DBA выбирает B-tree для точного поиска/соединения по ID и GiST geometry для поиска полигонов по области; не считать H3-индекс заменой пространственного индекса. Индекс по выражению должен соответствовать реальному выражению запроса, что предстоит проверить планом. [B-tree](https://github.com/postgis/h3-pg/blob/v4.5.0/h3/sql/install/11-opclass_btree.sql), [пространственные индексы PostGIS](https://postgis.net/docs/using_postgis_dbmanagement.html#build-indexes).

Есть явные casts `h3index ↔ bigint`. **Предложение интерфейса:** передавать H3 ID как шестнадцатеричную строку, включая свойства MVT, и отдельно выбрать стабильный feature ID. Не полагаться на неявную сериализацию пользовательского PostgreSQL-типа провайдерами. Типы, допустимые для MVT feature ID, — smallint/integer/bigint; h3index напрямую в этот список не входит. [Casts](https://github.com/postgis/h3-pg/blob/v4.5.0/h3/sql/install/20-casts.sql), [ST_AsMVT](https://postgis.net/docs/ST_AsMVT.html).

## Маршруты публикации

### Features через pygeoapi

PostgreSQL provider настраивает `table`, `id_field`, `geom_field`; поддерживает bbox, свойства, datetime, сортировку, CQL и CRS. Устанавливаемый набор Python-зависимостей включает SQLAlchemy, GeoAlchemy2 и psycopg2-binary. [Stable provider docs](https://docs.pygeoapi.io/en/stable/publishing/ogcapi-features.html#postgresql).

В 0.24.0 `get_table_model` отражает также views и добавляет ORM primary key из `id_field`. **Предложение:** если исходник хранит только H3 ID, DBA предоставляет view с уникальным непустым строковым ID, resolution, метриками и типизированной geometry boundary. Такой view — кандидат на обычную feature collection. Прямой вызов произвольной параметризованной SQL-функции не является описанным контрактом PostgreSQL feature provider. [Исходник provider/sql.py](https://github.com/geopython/pygeoapi/blob/0.24.0/pygeoapi/provider/sql.py).

### MVT через Martin

Martin function source принимает z/x/y и необязательный JSON параметров, возвращает bytea либо bytea + text для ETag. **Предложение:** DBA предоставляет ограниченную функцию формирования H3-агрегата по тайлу, если обычная таблица/view не выражает нужную агрегацию. Аргументы и разрешения требуется согласовать; платформа не создаёт функцию на внешнем источнике. [Function source](https://maplibre.org/martin/sources-pg-functions/).

Путь кодирования: границы H3 4326 → преобразование в CRS карты (обычно 3857) → `ST_AsMVTGeom` с областью тайла/буфером → `ST_AsMVT`. Первый этап преобразует и обрезает геометрию в координатах тайла, второй агрегирует строки в bytea и сохраняет остальные поля как атрибуты. **Предложение:** держать H3 ID/метрики атрибутами; не использовать обрезанную MVT-геометрию как аналитический эталон ячейки. [ST_AsMVTGeom](https://postgis.net/docs/ST_AsMVTGeom.html), [ST_AsMVT](https://postgis.net/docs/ST_AsMVT.html).

### Отдельный DGGS API

OGC публикует OGC API DGGS Part 1 Core 1.0.0. Среди ресурсов — `/dggs`, описание DGGRS, `/zones`, информация зоны и `/zones/{zoneId}/data`; предусмотрены zone-level, parent-zone и zone-depth. Это дополнительный контракт с семантикой иерархии и представлением данных. **Вывод:** публикация H3 через Features/MVT достаточна для показа и запросов объектов, но вопрос настоящего DGGS API нужно решать отдельно; встроенная поддержка pygeoapi не подтверждена. [Стандарт](https://ogcapi.ogc.org/dggs/), [overview](https://ogcapi.ogc.org/dggs/overview.html), [pygeoapi status](https://dive.pygeoapi.io/standards/).

## Изменения данных, discovery и свежесть

| Изменение | Подтверждённое поведение | Вывод для задачи |
| --- | --- | --- |
| INSERT/UPDATE/DELETE существующих строк | pygeoapi 0.24.0 выполняет query/get внутри нового Session; Martin 1.16.1 берёт соединение и выполняет query_opt для получения тайла. [pygeoapi SQL](https://github.com/geopython/pygeoapi/blob/0.24.0/pygeoapi/provider/sql.py), [Martin source](https://github.com/maplibre/martin/blob/martin-v1.16.1/martin-core/src/tiles/postgres/source.rs) | Вывод из кода: при реальном обращении к БД отдельный ручной refresh строк не нужен; кэшированный HTTP/тайловый ответ может скрывать изменение. |
| Commit и транзакции | Read Committed видит данные, committed до начала SELECT; Repeatable Read удерживает snapshot транзакции. [PostgreSQL isolation](https://www.postgresql.org/docs/current/transaction-iso.html) | Условие свежести: commit завершён, новый запрос дошёл до источника, нет старого snapshot/отстающей реплики. |
| Новая/изменённая таблица или функция Martin | Начиная с 1.11 PostgreSQL discovery повторяется по таймеру, default 10 минут. [Release 1.11](https://github.com/maplibre/martin/releases/tag/martin-v1.11.0) | Это обновление каталога, отдельно от чтения изменённых строк. Не обещать, что reload каталога отслеживает каждую запись. |
| Изменение колонок pygeoapi | `get_table_model` помечен functools.cache; поля строятся по модели. [0.24.0 source](https://github.com/geopython/pygeoapi/blob/0.24.0/pygeoapi/provider/sql.py) | Вывод из кода: DDL требует отдельного сценария обновления метаданных/worker; свежесть строк не доказывает свежесть схемы. |
| Materialized view | Возвращает сохранённые строки, новые вычисляются через REFRESH. [PostgreSQL](https://www.postgresql.org/docs/current/rules-materializedviews.html) | Без автоматического механизма DBA такой источник не выполняет требование о свежести исходных изменений. |

**Риск SQL-функций:** официальный пример Martin использует IMMUTABLE для функции, читающей таблицу. PostgreSQL предупреждает: такая маркировка может дать преждевременное вычисление и устаревший результат при повторном использовании плана. Для SELECT над изменяемыми таблицами подходит STABLE; чистое преобразование H3 ID в геометрию может оставаться IMMUTABLE. Martin 1.16.1 использует prepare_typed_cached. **Предложение DBA:** проверять volatility обёртки MVT отдельно от volatility H3-функций и не копировать IMMUTABLE из примера механически. Это выявленный риск, а не воспроизведённый дефект Martin. [Martin example](https://maplibre.org/martin/sources-pg-functions/), [PostgreSQL volatility](https://www.postgresql.org/docs/current/xfunc-volatility.html), [Martin query](https://github.com/maplibre/martin/blob/martin-v1.16.1/martin-core/src/tiles/postgres/source.rs).

В закреплённой конфигурации Martin 1.16.1 есть `cache: disable`; `cache.size_mb` имеет default 512, а 0 отключает кэш. `cache.expiry` и `cache.idle_timeout` по умолчанию null: ограниченный срок хранения не задан. `tile_expiry`/`tile_idle_timeout` переопределяют эти параметры для тайлов; значения 1h/30m в примере не являются defaults. `cache_control` отдельно задаёт HTTP-заголовок. Опциональный `endpoints.purge_cache` включает `DELETE /cache/{source_id}`, default false; сам маршрут не аутентифицирует запрос. [Pinned config 1.16.1](https://github.com/maplibre/martin/blob/martin-v1.16.1/docs/content/files/generated_config.md).

**Предложение политики свежести:** сначала определить допустимую задержку после commit. Для строгой проверки следующего запроса исключить хранение старого ответа во всех слоях: Martin, gateway/CDN, браузер и клиент карты; либо обеспечить автоматическую инвалидацию. ETag помогает валидировать ответ, но не доказывает, что сервер перечитал БД. Смена URL вручную, рестарт и ручной purge не являются выполнением требования. При разрешённой задержке выбирать явный TTL; idle timeout сам по себе не задаёт максимальный возраст регулярно читаемого тайла. Основание — раздельные TTL/TTI в [pinned config](https://github.com/maplibre/martin/blob/martin-v1.16.1/docs/content/files/generated_config.md).

## Агрегация и стоимость

Иерархия H3 обеспечивает точное логическое родство, но геометрия дочерней ячейки не обязана целиком лежать внутри родительской. **Вывод:** два алгоритма — сначала индексировать точку на тонком уровне и брать parent либо сразу индексировать точку на грубом уровне — могут различаться около границ. Нужно выбрать семантику показателей до выбора оптимизации. [H3 indexing](https://h3geo.org/docs/highlights/indexing/).

**Предложение для обсуждения:** хранить/вычислять счётчики и суммы по ячейкам; среднее получать из sum/count, а не усреднять средние. Для полигонов отдельно выбрать centre inclusion, overlap или распределение значения по площади. `compact_cells` сжимает набор идентификаторов, не определяет агрегацию метрик. [H3 hierarchy API](https://h3geo.org/docs/api/hierarchy/), [region semantics](https://h3geo.org/docs/api/regions/).

**Оценка без бенчмарка:** затраты формируют выбор строк, преобразование CRS, присвоение H3, GROUP BY, построение границ, clipping/encoding и число одновременно запрошенных тайлов. Увеличение разрешения резко увеличивает число ячеек: H3 использует aperture 7. Предварительная агрегация сокращает вычисления чтения, но требует места и автоматического сопровождения изменяемых данных. Нельзя назвать безопасный resolution, объём или время ответа без измерений на согласованном источнике. [Устройство сетки](https://h3geo.org/docs/core-library/overview/), [PostGIS MVT path](https://postgis.net/docs/ST_AsMVTGeom.html), [материализация](https://www.postgresql.org/docs/current/rules-materializedviews.html).

## Вопросы для решений и последующей проверки

Это кандидаты для будущего согласования; состав уровней тестирования здесь не определяется.

1. Нужен ли контракт OGC API DGGS или достаточно H3 Features + MVT? Какие клиенты должны его потреблять?
2. Какой срок видимости после commit допустим: следующий обычный запрос или ограниченная задержка? Кто обеспечивает автоматическую инвалидацию и свежесть реплики?
3. Что уже предоставляет DBA: версия PostgreSQL/PostGIS/h3/h3_postgis, read-only таблица/view, boundary geometry, H3 ID, индексы, функция MVT? Можно ли добавить недостающие объекты через DBA?
4. Каковы область, объём, тип данных, частота изменений, нужные метрики, resolution и zoom? Как трактовать границы, NULL и отсутствие данных?
5. Проверить в согласованном окружении уникальность ID, сериализацию H3, CRS и lon/lat, пятиугольники, 180-й меридиан и полярные края; сравнить Features и декодированный MVT с эталонным SELECT.
6. Владелец тестового источника выполняет INSERT, UPDATE атрибута/геометрии/H3 и DELETE с commit; платформа повторяет тот же обычный URL и проверяет итог без ручного refresh, включая ранее пустой тайл, условный запрос ETag и уже открытый клиент карты.
7. Отдельно проверить DDL/discovery и смену схемы: они не входят автоматически в обещание видимости DML. Согласовать, разрешены ли автоматический reload либо плановый restart при изменении схемы.
8. Только после выбора данных и проверок измерить планы запросов, нагрузку и задержку; полученные отчёты/логи хранить в `test_results/`. Фактические значения в этом исследовании отсутствуют.
