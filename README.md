# Складской учёт - микросервисы на TypeScript

Контейнеризованное микросервисное приложение для учёта складских остатков. Три HTTP-сервиса на TypeScript / Node.js поверх PostgreSQL, Redis и RabbitMQ, с полным observability-стеком (Prometheus, Grafana, Alertmanager).

Проект демонстрирует базовые архитектурные шаблоны: cache-aside, event-driven architecture, CQRS, Event Sourcing, observability. Поднимается одной командой `docker compose up -d --build`.

## Содержание

- [Стек](#стек)
- [Сервисы](#сервисы)
- [Архитектура](#архитектура)
- [Быстрый старт](#быстрый-старт)
- [Endpoints](#endpoints)
- [API и Swagger UI](#api-и-swagger-ui)
- [Архитектурные паттерны](#архитектурные-паттерны)
- [Конфигурация](#конфигурация)
- [Структура проекта](#структура-проекта)
- [Разработка](#разработка)
- [Troubleshooting](#troubleshooting)

## Стек

| Слой                | Технология                                 |
| ------------------- | ------------------------------------------ |
| Язык                | TypeScript 5, Node.js 20                   |
| HTTP                | Express 4                                  |
| Валидация / OpenAPI | zod 4 + `@asteasolutions/zod-to-openapi`   |
| БД                  | PostgreSQL 16 (`pg`, без ORM)              |
| Кеш                 | Redis 7 (`ioredis`)                        |
| Брокер              | RabbitMQ 3.13 (`amqplib`)                  |
| Метрики             | `prom-client`                              |
| Observability       | Prometheus, Grafana, Alertmanager, Mailpit |
| Контейнеризация     | Docker, docker-compose v2                  |

## Сервисы

| Сервис               | Порт | Назначение                                                              |
| -------------------- | ---- | ----------------------------------------------------------------------- |
| product-service      | 8080 | Каталог товаров, REST CRUD с cache-aside поверх Redis                   |
| stock-service        | 8081 | Учёт остатков, CQRS + Event Sourcing, публикация `stock.low` в RabbitMQ |
| notification-service | 8082 | Consumer `stock.low`, лог + SMTP-уведомление в Mailpit                  |

## Архитектура

**App tier** (3 сервиса): product-service, stock-service, notification-service.

**Infra tier** (7 сервисов): postgres (две БД: `product_db` и `stock_db`), redis, rabbitmq, prometheus, grafana, alertmanager, mailpit.

Потоки данных:

- **product-service → redis (cache-aside):** на `GET /products/:id` проверяется ключ; при miss идёт SELECT в `product_db` и значение кладётся в кеш; на `POST/PUT/DELETE` ключ инвалидируется.
- **stock-service → postgres → rabbitmq:** команды пишут события в append-only лог `stock_db.events`, синхронный проектор обновляет read model `stock_balances` / `stock_movement`; при пересечении порога публикуется `stock.low` в exchange `warehouse.exchange`.
- **rabbitmq → notification-service:** consumer на durable-очереди `stock.low.notifications` пишет лог-строку и шлёт письмо через SMTP в Mailpit; невалидные сообщения уходят в DLX (`warehouse.dlx` → `stock.low.dlq`).
- **Все три сервиса → `/actuator/prometheus`:** Prometheus скрейпит с интервалом 15s, Grafana строит дашборды, Alertmanager шлёт оповещения в Mailpit.

## Быстрый старт

Требования: Docker (Engine 24+), Docker Compose v2.

```bash
git clone <repo-url>
cd archfinal
cp .env.example .env       # при желании отредактировать пароли / порты
docker compose up -d --build
```

Подождать ~30-45 секунд (старт сервисов синхронизирован через `depends_on: condition: service_healthy`). После этого все endpoint'ы доступны.

Остановка:

```bash
docker compose down            # сохранить volumes
docker compose down -v         # с очисткой данных
```

## Endpoints

| Сервис / UI                         | URL                             |
| ----------------------------------- | ------------------------------- |
| product-service health              | http://localhost:8080/health    |
| stock-service health                | http://localhost:8081/health    |
| notification-service health         | http://localhost:8082/health    |
| product-service Swagger UI          | http://localhost:8080/docs      |
| stock-service Swagger UI            | http://localhost:8081/docs      |
| notification-service Swagger UI     | http://localhost:8082/docs      |
| Event store dashboard               | http://localhost:8081/dashboard |
| Prometheus                          | http://localhost:9090/targets   |
| Grafana (admin / admin)             | http://localhost:3000           |
| Alertmanager                        | http://localhost:9093           |
| Mailpit                             | http://localhost:8025           |
| RabbitMQ management (guest / guest) | http://localhost:15672          |

## API и Swagger UI

OpenAPI 3.0 + Swagger UI смонтированы на каждом HTTP-сервисе:

| Сервис               | Swagger UI                 | OpenAPI JSON                    |
| -------------------- | -------------------------- | ------------------------------- |
| product-service      | http://localhost:8080/docs | http://localhost:8080/docs/json |
| stock-service        | http://localhost:8081/docs | http://localhost:8081/docs/json |
| notification-service | http://localhost:8082/docs | http://localhost:8082/docs/json |

Документация генерируется из тех же zod-схем, которые валидируют входящие запросы (`@asteasolutions/zod-to-openapi`). Единый source of truth: невозможно «разъехаться» валидации и контракта, потому что одна и та же `z.object(...)` описывает обе стороны.

## Архитектурные паттерны

### Cache-aside (product-service)

При `GET /products/:id`:

1. Проверка ключа в Redis. На hit - вернуть значение, инкремент `cache_requests_total{result="hit"}`.
2. На miss - SELECT в Postgres, положить в Redis с TTL, инкремент `cache_requests_total{result="miss"}`.

На `POST / PUT / DELETE` ключ удаляется явно (`DEL`), без write-through. Это сохраняет инвариант «кеш не содержит устаревших данных» без необходимости синхронной записи в обе стороны.

### Event Sourcing (stock-service)

Состояние агрегата хранится не как текущая запись, а как append-only лог событий в таблице `events`:

```sql
CREATE TABLE events (
  aggregate_id TEXT NOT NULL,
  version      INT  NOT NULL,
  event_type   TEXT NOT NULL,
  payload      JSONB NOT NULL,
  occurred_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (aggregate_id, version)
);
```

Поддерживаемые типы событий: `STOCK_IN`, `STOCK_OUT`, `ADJUSTMENT`, `RESERVED`, `RELEASED`, `COMMITTED`. Никаких UPDATE / DELETE - только INSERT.

**Optimistic concurrency:** `UNIQUE(aggregate_id, version)` гарантирует, что параллельные команды на одном агрегате не запишут одну и ту же версию. Вторая транзакция получает HTTP 409, клиент повторяет команду после rehydrate.

**Снапшоты:** каждые `SNAPSHOT_EVERY` событий (по умолчанию 50) записывается JSONB-снапшот в `snapshots`. При rehydrate агрегат загружается с последнего снапшота и доигрывает только хвост.

**Корректировки:** ошибочные движения исправляются новым событием `ADJUSTMENT` с `quantity_delta` и `reason_code`, не UPDATE-ом по `events`. Audit trail сохраняется.

**Replay:** read model восстанавливается из event log:

```bash
curl -X POST http://localhost:8081/admin/replay \
  -H "X-Admin-Key: <ADMIN_KEY>"
```

### CQRS (stock-service)

Физическое разделение моделей записи и чтения:

- **Write side:** `POST /stock/commands/*` → aggregate → INSERT в `events` → синхронный проектор обновляет `stock_balances` / `stock_movement` в той же транзакции.
- **Read side:** `GET /stock`, `GET /stock/movements`, `GET /stock/:productId/:warehouseId` читают **только** из read-модели. Никаких ad-hoc JOIN-ов по `events` из query-роутов.

Команды и запросы зарегистрированы в разных Express router'ах (`commands.router.ts` и `query.router.ts`), физически расположены в разных файлах. Read model - производный артефакт, его можно полностью перестроить через `/admin/replay`.

### Event-Driven Architecture (stock-service ↔ notification-service)

При пересечении `LOW_STOCK_THRESHOLD` сверху вниз stock-service публикует событие в RabbitMQ:

- **Exchange** `warehouse.exchange` (topic, durable)
- **Routing key** `stock.low`
- **Queue** `stock.low.notifications` (durable, с DLX-arguments)
- **DLX** `warehouse.dlx` → `stock.low.dlq` для невалидных сообщений

Notification-service потребляет очередь, на каждое валидное сообщение пишет лог-строку и шлёт письмо в Mailpit. Невалидный JSON уходит в DLQ через DLX, consumer **не** уходит в crash-loop.

При холодном старте publisher умеет переподключаться: если RabbitMQ ещё не healthy, делается экспоненциальный backoff `1s → 2s → 4s → 8s → 16s` (до 5 попыток). Очередь и exchange объявляются durable, persistent-сообщения не теряются при перезапуске брокера.

### Observability

Каждый сервис экспортирует Prometheus-метрики на `/actuator/prometheus`:

| Сервис               | Бизнес-метрики                                                                            |
| -------------------- | ----------------------------------------------------------------------------------------- |
| product-service      | `cache_requests_total{result="hit\|miss"}`                                                |
| stock-service        | `stock_commands_total{command}`, `stock_events_published_total`, `projection_lag_seconds` |
| notification-service | `stock_events_consumed_total{event_type}`, `low_stock_alerts_total`                       |

Default-метрики Node.js (event loop lag, heap, CPU) добавляются автоматически через `collectDefaultMetrics()`.

Prometheus скрейпит четыре target'а (3 сервиса + сам RabbitMQ через `rabbitmq_prometheus` plugin). Grafana provisioning подгружает три дашборда (по одному на сервис) при старте контейнера. Alertmanager роутит alert'ы по правилам из `observability/alert_rules.yml`; SMTP-приёмник - Mailpit для разработки.

### Mini event-store dashboard

`http://localhost:8081/dashboard` - server-rendered HTML (без клиентского framework'а):

- `/dashboard` - список aggregate ID + лента последних 20 событий.
- `/dashboard/aggregate/:id` - поток событий, снапшоты, текущее folded-state.
- `/dashboard/replay` - GET показывает before-state и форму, POST триггерит rebuild read-модели и показывает before/after на одной странице.

POST `/dashboard/replay` гарантирует HTTP 200 даже если projection-таблицы дропнуты (degraded-state с информативным сообщением). События остаются immutable: COUNT(\*) по `events` до и после replay одинаковый.

## Конфигурация

Вся конфигурация - через переменные окружения. См. `.env.example`. Основное:

| Переменная                            | По умолчанию          | Назначение                                                |
| ------------------------------------- | --------------------- | --------------------------------------------------------- |
| `POSTGRES_USER` / `POSTGRES_PASSWORD` | archuser / archpass   | Креды Postgres                                            |
| `PRODUCT_DB_NAME` / `STOCK_DB_NAME`   | product_db / stock_db | Имена per-service БД                                      |
| `REDIS_HOST` / `REDIS_PORT`           | redis / 6379          | Подключение к Redis                                       |
| `RABBITMQ_HOST` / `RABBITMQ_PORT`     | rabbitmq / 5672       | AMQP                                                      |
| `RABBITMQ_USER` / `RABBITMQ_PASS`     | guest / guest         | RabbitMQ креды                                            |
| `PRODUCT_SERVICE_PORT`                | 8080                  | Внешний порт product-service                              |
| `STOCK_SERVICE_PORT`                  | 8081                  | Внешний порт stock-service                                |
| `NOTIFICATION_SERVICE_PORT`           | 8082                  | Внешний порт notification-service                         |
| `LOW_STOCK_THRESHOLD`                 | 10                    | Порог публикации `stock.low`                              |
| `SNAPSHOT_EVERY`                      | 50                    | Через сколько событий записывать снапшот                  |
| `ADMIN_KEY`                           | changeme              | Защита `POST /admin/replay` через заголовок `X-Admin-Key` |
| `GF_SECURITY_ADMIN_PASSWORD`          | admin                 | Пароль Grafana admin                                      |

Перед публичным деплоем поменять как минимум `POSTGRES_PASSWORD`, `RABBITMQ_PASS`, `ADMIN_KEY` и `GF_SECURITY_ADMIN_PASSWORD`. `.env` в репозиторий не коммитится (см. `.gitignore`).

## Разработка

Локальный запуск сервиса (без Docker, для отладки):

```bash
cd <service>                # product-service / stock-service / notification-service
npm ci
npm run dev                 # tsx watch src/index.ts
```

Type-check и production-сборка:

```bash
npm run build               # tsc -> dist/
npm start                   # node dist/index.js
```

EDA smoke-test (durability при restart RabbitMQ):

```bash
bash stock-service/scripts/eda-smoke-test.sh
```

## Troubleshooting

**1. Сервис в состоянии `starting` или ECONNREFUSED в логах.**
Инфраструктурный контейнер ещё не прошёл healthcheck. Подождать 10-15 секунд: `depends_on: condition: service_healthy` поднимет приложение, когда зависимость станет healthy. Проверить: `docker compose ps` и `docker compose logs <service>`.

**2. В логах product-service не видно `cache hit`.**
Проверить, что Redis в состоянии `healthy` (`docker compose ps redis`). Если продукт удалён между запросами, на втором GET закономерно будет 404. Сбросить кеш: `docker compose restart redis product-service`.

**3. Swagger UI возвращает 500 или пустую страницу.**
Сервис ещё не завершил bootstrap. Подождать 5 секунд. Если `/docs` работает, а `/docs/json` возвращает HTML - нарушен порядок mount'а в `index.ts`: `/docs/json` должен быть зарегистрирован **до** middleware `swaggerUi.serve`.

**4. `stock.low` не появляется в notification-service.**
Две возможные причины:

а) Остаток не пересёк `LOW_STOCK_THRESHOLD` сверху вниз. Alert триггерится только в переходе `>threshold` → `≤threshold`. Если изначально остаток уже ≤10, нужно сделать stock-in выше порога, потом stock-out обратно ниже.

б) Publisher не успел подключиться к RabbitMQ на холодном старте (в логах `publish skipped (reconnecting)` или `publisher reconnect attempt N`). Сервис сам перезапускает publisher через экспоненциальный backoff `1s → 2s → 4s → 8s → 16s` (5 попыток). Подождать до 30 секунд - должна появиться строка `publisher reconnected` / `publisher connected to RabbitMQ`. Если все попытки исчерпаны (`publisher giving up reconnect attempts`), вручную: `docker compose restart stock-service`.

**5. Grafana показывает «No data».**
Проверить `http://localhost:9090/targets` - все four target'а должны быть в состоянии UP. Если нет: `docker compose restart prometheus`. Если есть, но в Grafana пусто - метрики появляются только после первого вызова соответствующего endpoint'а (сходить curl'ом, затем перезагрузить Grafana).

**6. Очередь `stock.low.notifications` накопила сообщения в DLQ.**
Открыть `http://localhost:15672` (guest / guest) → Queues → `stock.low.dlq`. Содержимое - сообщения, которые не прошли JSON.parse в consumer'е. Очистить вручную через UI или повторно опубликовать после исправления.
