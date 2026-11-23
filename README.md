# GIS Platform

Платформа для публикации ГИС-сервисов различных типов на основе решений с открытым исходным кодом и современных стандартов работы с геопространственными данными.

## Локальная публикация GeoJSON

В примере одна публичная коллекция OGC API — Features. CLI применяет общий YAML и запускает Caddy и pygeoapi через Docker Compose. Для запуска используйте Node.js 24 или новее и Docker с Compose v2. Конфигурация без публикаций требует Compose 2.24.4 или новее. В Windows выполняйте команды в пользовательском дистрибутиве WSL 2 с включённой интеграцией Docker Desktop. Разместите рабочую копию в файловой системе этого дистрибутива, например в `~/gis-platform`.

Убедитесь, что порт 8080 свободен. Для пробы на другом порту используйте отдельную копию YAML. [Локальная проба и настройка порта](ADMIN.md#локальная-проба-с-geojson)

```sh
npm ci
npm run build
export COMPOSE_PROJECT_NAME=gis-readme-demo
export GIS_STATE_DIR="$PWD/.gis-platform/readme-demo"
export GIS_PUBLIC_BIND=127.0.0.1
node dist/cli.js config validate examples/features.yaml
node dist/cli.js config plan examples/features.yaml
```

Передайте выведенный ID плана в `node dist/cli.js config apply <plan-id>`. После успешного применения проверьте ответы через шлюз.

```sh
curl -fsS 'http://localhost:8080/features/collections?f=json'
curl -fsS 'http://localhost:8080/features/openapi?f=json'
curl -fsS 'http://localhost:8080/features/collections/places/items?f=json&limit=1'
curl -fsS 'http://localhost:8080/features/collections/places/items/central?f=json'
curl -fsS 'http://localhost:8080/features/collections/places/items?f=json&bbox=37,55,38,56'
```

Путь к GeoJSON задаётся относительно YAML или абсолютным путём. Используйте `FeatureCollection` хотя бы с одним объектом и уникальным строковым `id` у каждого объекта. Для локального примера Caddy слушает loopback, а pygeoapi читает только смонтированный файл. После редактирования YAML создайте и примените новый план. [GeoPackage, Shapefile, GeoParquet и настройка CRS](ADMIN.md#файлы-и-системы-координат-features)

Планы и подтверждённая конфигурация этого примера хранятся в `GIS_STATE_DIR`. Для диагностики из нового терминала снова задайте `COMPOSE_PROJECT_NAME` и `GIS_STATE_DIR`, затем выполните `node dist/cli.js doctor`. [Остановка и запуск контейнеров](ADMIN.md#остановить-запустить-или-перезапустить)

После прерванного применения проверьте `node dist/cli.js status --json`. Порядок восстановления зависит от завершившейся фазы и результата CLI. [Действия после прерванного применения](ADMIN.md#если-применение-прервалось)

## Файлы конфигурации YAML

`<platform.yaml>` и `<integration.yaml>` в справке CLI обозначают пути к файлам. Имена файлов можно выбрать самостоятельно.

| Файл | Назначение | Пример |
| --- | --- | --- |
| `platform.yaml` | Полная конфигурация платформы. В ней задаются внешний адрес, подключения к внешним БД, источники, экземпляры сервис-провайдеров, публикации и настройки доступа. Этот файл принимают `config validate` и `config plan`. | [Публикация GeoJSON](examples/features.yaml), [несколько протоколов](examples/provider-protocols.yaml), [публикация H3 через DGGS](examples/h3-parquet.yaml) |
| `integration.yaml` | Настройки одного экземпляра сервис-провайдера для `provider add`. CLI добавляет их в `providers.<id>` общего YAML и берёт образ Docker из аргумента команды. | [Интеграция pygeoapi](examples/provider-features.yaml) |

Назначение каждого параметра указано в `description` в [JSON Schema платформы](src/platform.schema.json). Для `integration.yaml` используйте описание одной записи в `providers`. [Структура файлов и проверка перед применением](ADMIN.md#файлы-конфигурации-yaml)

### Публичный адрес за HTTPS-прокси

Прокси может принимать запросы на `https://gis.example.org` и подключаться к Caddy по HTTPS на порту `1443`. В `server.public_url` задайте адрес для клиентов, а в `server.port` укажите порт Caddy на хосте. [Настройка TLS и прокси](ADMIN.md#внешний-http-и-https)

```yaml
server:
  host: gis.example.org
  port: 1443
  public_url: https://gis.example.org
  tls:
    cert_file: secrets/tls/fullchain.pem
    key_file: secrets/tls/server-key.pem
```

## Источники PostGIS

Задайте подключения к внешним базам в `postgis_connections` и выберите подключение в `sources.<id>.connection` каждого источника PostGIS. Все публикации одного источника читают одну БД. Один экземпляр pygeoapi может выдавать Features из нескольких БД и из файлов. Один Martin может выдавать тайлы из нескольких БД и архивов. При обновлении старого YAML перенесите `providers.<id>.postgis` в реестр подключений. [Подготовка данных PostGIS](ADMIN.md#подготовить-данные-postgis)

## Экземпляры сервис-провайдеров и адреса

Для управляемого экземпляра укажите поддерживаемые протоколы в `api.protocols`. Шлюз создаёт отдельный корень для каждого протокола. Например, один экземпляр pygeoapi может обслуживать `/pygeoapi/features`, `/pygeoapi/maps` и `/pygeoapi/tiles`. По умолчанию публичный префикс совпадает с ID экземпляра, а `api.public_prefix` позволяет задать его отдельно. [Настройка экземпляров и переход на вложенные адреса](ADMIN.md#управление-сервис-провайдерами)

## Растровая публикация

Публикуйте GeoTIFF или COG через OGC API — Maps. Caddy выдаёт PNG для указанного охвата и размера с учётом прав на публикацию. [Настройка YAML, запрос PNG и пределы размеров](ADMIN.md#растровая-публикация-maps)

## Векторные тайлы

Публикуйте векторные веб-тайлы из PostGIS, MBTiles и PMTiles через Martin. MapLibre GL JS читает TileJSON и связанные тайлы через шлюз. [Настройка MVT и доступа из браузера](ADMIN.md#векторные-веб-тайлы-mvt-через-martin)

Публикуйте векторные тайлы из PostGIS через OGC API — Tiles. Клиент получает список наборов, описание WebMercatorQuad и MVT по ссылкам шлюза. [Настройка публикации Tiles](ADMIN.md#векторные-тайлы-через-ogc-api--tiles)

## Регистрация и доступ

Добавьте в общий YAML раздел `auth`. Публикации `access: public` доступны всем. Режим `access: registered` доступен активной учётной записи с подтверждённым email через веб-сеанс или персональный токен. Режим `access: private` дополнительно требует персонального разрешения или роли администратора. Для одного источника GeoJSON можно настроить несколько публикаций со своими ID и правами. [Настройка закрытых публикаций и CLI](ADMIN.md#настройка-закрытых-публикаций-и-локального-cli)

```yaml
auth:
  mode: development
  secret_file: .gis-platform/auth-secret
  postgres_password_file: .gis-platform/postgres-password
  mailpit_port: 8025
```

Пути задаются относительно YAML. Для примера с YAML в корне репозитория создайте два независимых секрета и примените конфигурацию через `config plan` и `config apply`.

```sh
mkdir -p .gis-platform
umask 077
openssl rand -hex 32 > .gis-platform/auth-secret
openssl rand -hex 32 > .gis-platform/postgres-password
```

Откройте `/account/register` по адресу платформы. Письма доступны в Mailpit на `http://localhost:8025`. После подтверждения email войдите через `/account/login`. Каталог `/features/collections` покажет доступные публикации. В `/account/profile` можно изменить отображаемое имя и перейти к смене пароля. Адреса email хранятся в нижнем регистре. Точки и `+` остаются частью адреса.

Учётные записи, сеансы, персональные разрешения и хеши персональных токенов хранятся в именованном томе Compose `accounts`. При обновлении стека используйте прежние имя проекта и файлы секретов, чтобы сохранить эти данные.

Для production задайте `auth.mode: production` и замените `mailpit_port` на параметры внешнего SMTP-реле.

```yaml
  smtp:
    host: relay.example.org
    port: 587
    from: GIS Platform <accounts@example.org>
    username: gis-platform
    password_file: .gis-platform/smtp-password
```

Реле должно поддерживать STARTTLS. Для TLS с момента подключения укажите `smtp.secure: true`. Для реле без SMTP-аутентификации опустите `username` и `password_file`. Письма, ссылки Features и cookie используют внешний адрес платформы. [Настройка внешнего HTTP или HTTPS](ADMIN.md#внешний-http-и-https)

### Персональный токен для QGIS

1. Войдите в платформу по паролю. В профиле откройте **Personal tokens** (`/account/tokens`), назовите токен, например `QGIS`, и создайте его. Скопируйте секрет, пока он показан на странице.
2. В QGIS откройте подключение **WFS / OGC API – Features** и укажите корень протокола Features. В локальном примере это `http://localhost:8080/features`, а для экземпляра с публичным префиксом `pygeoapi` и вложенными адресами — `http://localhost:8080/pygeoapi/features`.
3. Создайте конфигурацию аутентификации **API Header**. Введите имя заголовка `Authorization` и значение `Bearer <секрет>` с пробелом после `Bearer`. Сохраните конфигурацию и выберите её в подключении. Нажмите **Подключиться** и выберите доступную публикацию.

Токен использует текущие права вашей учётной записи. Допущенный запрос к публикации продлевает срок токена на 90 дней. Отдельный токен можно отозвать на той же странице. Смена или восстановление пароля отзывает все токены и прежние веб-сеансы. [Задача #17](https://github.com/stepanosokin/gis-platform/issues/17)

## Материалы

- [Навыки Codex и OpenCode и команды черновика](ADMIN.md#навыки-и-черновик-конфигурации).
- [Развёртывание на сервере в /opt/gis-platform](ADMIN.md#развёртывание-на-сервере).
- [Правила работы и тестирования](AGENTS.md).
- [Локальный запуск автотестов](tests/README.md).
- [Стартовая спецификация первой версии](https://github.com/stepanosokin/gis-platform/issues/13).
- [Глоссарий проекта](GLOSSARY.md).
- [Сравнение вариантов компонента доступа](docs/research/auth-stack-comparison.md).
- [Конфиг и шлюз: проверенные границы](docs/research/gateway-config-options.md).
