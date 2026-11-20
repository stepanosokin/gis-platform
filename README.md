# GIS Platform

Платформа для публикации ГИС-сервисов различных типов на основе решений с открытым исходным кодом и современных стандартов работы с геопространственными данными.

## Локальная публикация GeoJSON

В примере одна публичная коллекция OGC API — Features. CLI применяет общий YAML и запускает Caddy и pygeoapi через Docker Compose. Для запуска используйте Node.js 24 или новее и Docker с Compose v2. Конфигурация без публикаций требует Compose 2.24.4 или новее. В Windows выполняйте команды в пользовательском дистрибутиве WSL 2 с включённой интеграцией Docker Desktop. Разместите рабочую копию в файловой системе этого дистрибутива, например в `~/gis-platform`.

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

Реле должно поддерживать STARTTLS. Для TLS с момента подключения укажите `smtp.secure: true`. Для реле без SMTP-аутентификации опустите `username` и `password_file`. Для HTTPS укажите `server.tls.cert_file` и `server.tls.key_file` и задайте в `server.host` имя из сертификата. Письма, ссылки Features и cookie используют настроенный внешний адрес. [Задача #15](https://github.com/stepanosokin/gis-platform/issues/15) · [Полная приёмка транспорта #31](https://github.com/stepanosokin/gis-platform/issues/31)

### Персональный токен для QGIS

1. Войдите в платформу по паролю. В профиле откройте **Personal tokens** (`/account/tokens`), назовите токен, например `QGIS`, и создайте его. Скопируйте секрет, пока он показан на странице.
2. В QGIS откройте подключение **WFS / OGC API – Features** и укажите URL платформы с путём `/features`. Для локального примера это `http://localhost:8080/features`.
3. Создайте конфигурацию аутентификации **API Header**. Введите имя заголовка `Authorization` и значение `Bearer <секрет>` с пробелом после `Bearer`. Сохраните конфигурацию и выберите её в подключении. Нажмите **Подключиться** и выберите доступную публикацию.

Токен использует текущие права вашей учётной записи. Допущенный запрос к публикации продлевает срок токена на 90 дней. Отдельный токен можно отозвать на той же странице. Смена или восстановление пароля отзывает все токены и прежние веб-сеансы. [Задача #17](https://github.com/stepanosokin/gis-platform/issues/17)

## Материалы

- [Правила работы и тестирования](AGENTS.md).
- [Локальный запуск автотестов](tests/README.md).
- [Стартовая спецификация первой версии](https://github.com/stepanosokin/gis-platform/issues/13).
- [Глоссарий проекта](GLOSSARY.md).
- [Сравнение вариантов компонента доступа](docs/research/auth-stack-comparison.md).
- [Конфиг и шлюз: проверенные границы](docs/research/gateway-config-options.md).
