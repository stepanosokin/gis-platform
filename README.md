# GIS Platform

Платформа для публикации ГИС-сервисов различных типов на основе решений с открытым исходным кодом и современных стандартов работы с геопространственными данными.

## Локальная публикация GeoJSON

В примере одна публичная коллекция OGC API — Features. CLI применяет общий YAML и запускает Caddy и pygeoapi через Docker Compose. Для запуска используйте Node.js 24 или новее и Docker с Compose v2. В Windows выполняйте команды в пользовательском дистрибутиве WSL 2 с включённой интеграцией Docker Desktop. Разместите рабочую копию в файловой системе этого дистрибутива, например в `~/gis-platform`.

```sh
npm ci
npm run build
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

Путь к GeoJSON задаётся относительно YAML или абсолютным путём. Используйте `FeatureCollection` с уникальным строковым `id` у каждого объекта. Для локального примера Caddy слушает loopback, а pygeoapi читает только смонтированный файл. После редактирования YAML создайте и примените новый план.

CLI хранит планы и рабочую конфигурацию в `.gis-platform/`. Остановить локальный пример можно командой `docker compose stop`, возобновить — `docker compose start`.

## Материалы

- [Правила работы и тестирования](AGENTS.md).
- [Локальный запуск автотестов](tests/README.md).
- [Стартовая спецификация первой версии](https://github.com/stepanosokin/gis-platform/issues/13).
- [Глоссарий проекта](GLOSSARY.md).
- [Сравнение вариантов компонента доступа](docs/research/auth-stack-comparison.md).
- [Конфиг и шлюз: проверенные границы](docs/research/gateway-config-options.md).
