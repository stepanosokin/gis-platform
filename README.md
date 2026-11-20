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

Путь к GeoJSON задаётся относительно YAML или абсолютным путём. Используйте `FeatureCollection` хотя бы с одним объектом и уникальным строковым `id` у каждого объекта. Для локального примера Caddy слушает loopback, а pygeoapi читает только смонтированный файл. После редактирования YAML создайте и примените новый план.

CLI хранит планы и рабочую конфигурацию в `.gis-platform/`. Остановить локальный пример можно командой `docker compose stop`, возобновить — `docker compose start`.

Если принудительно завершённый `config apply` оставил каталог `.gis-platform/apply.lock`, убедитесь, что процессы применения и Compose завершились. Удалите пустой каталог блокировки и повторите `config apply`. CLI сначала восстановит последнюю подтверждённую конфигурацию.

## Регистрация и доступ

Добавьте в общий YAML раздел `auth`. Для публикации, которая требует действующего сеанса, укажите `access: registered`. Публикации `access: public` доступны всем. Один источник GeoJSON можно указать в обеих публикациях с разными ID.

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

Учётные записи и сеансы хранятся в именованном томе Compose `accounts`. При обновлении стека используйте прежние имя проекта и файлы секретов, чтобы сохранить учётные записи и сеансы.

Для production задайте `auth.mode: production` и замените `mailpit_port` на параметры внешнего SMTP-реле.

```yaml
  smtp:
    host: relay.example.org
    port: 587
    from: GIS Platform <accounts@example.org>
    username: gis-platform
    password_file: .gis-platform/smtp-password
```

Реле должно поддерживать STARTTLS. Для TLS с момента подключения укажите `smtp.secure: true`. Для реле без SMTP-аутентификации опустите `username` и `password_file`. Для HTTPS укажите `server.tls.cert_file` и `server.tls.key_file` и задайте в `server.host` имя из сертификата. Письма, ссылки Features и cookie используют настроенный внешний адрес. [Задача #15](https://github.com/stepanosokin/gis-platform/issues/15) · [Полная приёмка транспорта #31](https://github.com/stepanosokin/gis-platform/issues/31)

## Материалы

- [Правила работы и тестирования](AGENTS.md).
- [Локальный запуск автотестов](tests/README.md).
- [Стартовая спецификация первой версии](https://github.com/stepanosokin/gis-platform/issues/13).
- [Глоссарий проекта](GLOSSARY.md).
- [Сравнение вариантов компонента доступа](docs/research/auth-stack-comparison.md).
- [Конфиг и шлюз: проверенные границы](docs/research/gateway-config-options.md).
