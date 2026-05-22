# Курсовая работа: Складской учёт (микросервисы)

Контейнеризованное микросервисное приложение складского учёта. Три HTTP-сервиса на TypeScript / Node.js поверх PostgreSQL, Redis и RabbitMQ:

- **product-service** (порт 8080) — каталог товаров (REST CRUD) с cache-aside поверх Redis.
- **stock-service** (порт 8081) — учёт остатков, CQRS + Event Sourcing. Команды пишут события в append-only лог `events`, проектор синхронно строит read model `stock_balances` / `stock_movement`. На пересечении порога публикует `stock.low` в RabbitMQ.
- **notification-service** (порт 8082) — consumer `stock.low`, пишет alert в лог и отправляет письмо через Mailpit.

Курсовая работа по предмету «Архитектурирование» (МИСИС). Цель — оценка 5: ≥3 контейнерных сервиса, кеширование, межсервисное взаимодействие через брокер, мониторинг всех трёх сервисов, CQRS и Event Sourcing — всё демонстрируется одной командой `docker compose up -d --build`.

## Быстрый старт

```bash
git clone <repo-url>
cd archfinal
docker compose up -d --build
```

Подождать ~30-45 секунд (контейнеры стартуют через `depends_on: condition: service_healthy`). После этого все endpoint'ы доступны:

| Что                                  | URL                              |
| ------------------------------------ | -------------------------------- |
| product-service health               | http://localhost:8080/health     |
| stock-service health                 | http://localhost:8081/health     |
| notification-service health          | http://localhost:8082/health     |
| product-service Swagger UI           | http://localhost:8080/docs       |
| stock-service Swagger UI             | http://localhost:8081/docs       |
| notification-service Swagger UI      | http://localhost:8082/docs       |
| stock-service event store dashboard  | http://localhost:8081/dashboard  |
| Prometheus (targets)                 | http://localhost:9090/targets    |
| Grafana (admin / admin)              | http://localhost:3000            |
| Alertmanager                         | http://localhost:9093            |
| Mailpit (UI для писем от Alertmanager) | http://localhost:8025          |
| RabbitMQ management (guest / guest)  | http://localhost:15672           |

## Архитектура

Контейнеры:

- **App tier (3):** product-service, stock-service, notification-service.
- **Infra tier (7):** postgres (две БД: `product_db` и `stock_db`), redis, rabbitmq, prometheus, grafana, alertmanager, mailpit.

Потоки данных:

- product-service → redis (cache-aside): при `GET /products/:id` проверяется ключ, на miss идёт SELECT в `product_db`, после чего значение кладётся в кеш; на любой `POST/PUT/DELETE` ключ инвалидируется.
- stock-service → postgres (`stock_db.events`, append-only) → projector → `stock_balances` / `stock_movement` (read model) → RabbitMQ exchange `stock.events` с routing key `stock.low` (когда `available` пересекает `LOW_STOCK_THRESHOLD`).
- RabbitMQ → notification-service (consumer на очереди `stock.low.notifications`) → лог + SMTP в Mailpit.
- Все три сервиса → `/actuator/prometheus` → Prometheus (scrape 15s) → Grafana (дашборды) + Alertmanager → Mailpit.

## Сценарий защиты

Этот раздел — точный сценарий ответа преподавателю. Каждый шаг отвечает на один пункт критериев (R1-R6), содержит точную команду и ожидаемый результат на экране. Если все шаги отрабатывают так, как написано, оценка 5 защищаема без импровизации.

Подготовка перед началом (один раз):

```bash
docker compose down -v
docker compose up -d --build
sleep 45
docker compose ps
```

Все десять контейнеров должны быть в состоянии `Up` (и `healthy` там, где есть healthcheck).

### Шаг 1 - R1: ≥3 контейнерных сервиса, единый `docker compose up`

```bash
docker compose ps
curl -s http://localhost:8080/health
curl -s http://localhost:8081/health
curl -s http://localhost:8082/health
```

Ожидаемый результат: `docker compose ps` показывает не менее десяти контейнеров (3 приложения + postgres + redis + rabbitmq + prometheus + grafana + alertmanager + mailpit); каждый `/health` возвращает `{"ok":true}`.

### Шаг 2 - R2: Кеширование (cache-aside поверх Redis)

```bash
# создаём товар
PRODUCT_ID=$(curl -s -X POST http://localhost:8080/products \
  -H "Content-Type: application/json" \
  -d '{"sku":"DEMO-001","name":"Тестовый товар","unit":"шт","category":"demo"}' \
  | sed -E 's/.*"id":"([^"]+)".*/\1/')
echo "PRODUCT_ID=$PRODUCT_ID"

# первый GET - cache miss (читает из Postgres, кладёт в Redis)
curl -s "http://localhost:8080/products/$PRODUCT_ID" >/dev/null

# второй GET - cache hit (читает из Redis)
curl -s "http://localhost:8080/products/$PRODUCT_ID" >/dev/null

# смотрим логи
docker compose logs product-service --tail=20 | grep "cache"
```

Ожидаемый результат: в логе видно сначала строку `[product-service] cache miss`, потом `[product-service] cache hit`. Это и есть cache-aside: первый запрос промахивается, второй уже из кеша.

Дополнительно (счётчик в Prometheus):

```bash
curl -s http://localhost:8080/actuator/prometheus | grep "cache_requests_total"
```

Должны быть две серии: `cache_requests_total{result="hit"}` и `cache_requests_total{result="miss"}` с ненулевыми значениями.

### Шаг 3 - R3: Брокер (RabbitMQ, межсервисное взаимодействие)

Цель — провести остаток ниже `LOW_STOCK_THRESHOLD=10`, увидеть, как stock-service публикует `stock.low`, а notification-service это сообщение принимает.

```bash
# фиксированный aggregateId, чтобы все команды попали в одну стрим-историю
AGG=demo-prod-001-wh1

# 1) приход на склад 12 единиц
curl -s -X POST http://localhost:8081/stock/commands/stock-in \
  -H "Content-Type: application/json" \
  -d "{\"aggregateId\":\"$AGG\",\"productId\":\"$PRODUCT_ID\",\"warehouseId\":\"WH1\",\"quantity\":12}"

# 2) расход 5 - остаток 7, ниже порога 10
curl -s -X POST http://localhost:8081/stock/commands/stock-out \
  -H "Content-Type: application/json" \
  -d "{\"aggregateId\":\"$AGG\",\"productId\":\"$PRODUCT_ID\",\"warehouseId\":\"WH1\",\"quantity\":5}"

# проверяем логи stock-service - должна быть строка "low stock detected"
docker compose logs stock-service --tail=20 | grep "low stock"

# проверяем логи notification-service - должна быть строка "LOW STOCK"
docker compose logs notification-service --tail=20 | grep "LOW STOCK"
```

Ожидаемый результат:

- в логе stock-service: `[stock-service] low stock detected productId=... available=7 threshold=10`
- в логе notification-service: `[notification-service] LOW STOCK productId=... warehouseId=WH1 available=7 threshold=10`

Дополнительно — Mailpit (письмо ушло):

Открыть в браузере http://localhost:8025 — во входящих лежит письмо «LOW STOCK» с информацией о товаре. Это полный путь EDA: stock-service → RabbitMQ → notification-service → SMTP → Mailpit.

Дополнительно — RabbitMQ management UI:

Открыть http://localhost:15672 (guest / guest) → Exchanges → `stock.events`. Видно очередь `stock.low.notifications`, привязанную к routing key `stock.low`.

### Шаг 4 - R4: Мониторинг всех трёх сервисов

В браузере: http://localhost:9090/targets — преподаватель видит активные target'ы со State=UP для product-service:8080, stock-service:8081, notification-service:8082 (плюс rabbitmq:15692 и prometheus сам себя).

Метрики каждого сервиса доступны напрямую:

```bash
# product-service: cache hit/miss
curl -s http://localhost:8080/actuator/prometheus | grep -E "^cache_requests_total"

# stock-service: команды (stock_in / stock_out / adjustment / reserve / release / commit_reservation)
# и публикации событий
curl -s http://localhost:8081/actuator/prometheus | grep -E "^stock_commands_total|^stock_events_published_total"

# notification-service: события потреблены и low-stock alerts отправлены
curl -s http://localhost:8082/actuator/prometheus | grep -E "^stock_events_consumed_total|^low_stock_alerts_total"
```

Grafana: открыть http://localhost:3000 (admin / admin) → Dashboards. Provisioning подгружает три дашборда: product-service, stock-service, notification-service — на каждом видны панели с живыми данными по только что сгенерированным метрикам.

Alertmanager: http://localhost:9093 — активные/недавние alert'ы (правила лежат в `observability/alert_rules.yml`, ловят, например, ошибки публикации и падение target'ов; письма приходят в Mailpit).

### Шаг 5 - R5: CQRS (command / query разделены)

Write side (команды идут на отдельный router, попадают в aggregate, аппендят события, синхронно обновляют read model):

```bash
curl -s -X POST http://localhost:8081/stock/commands/stock-in \
  -H "Content-Type: application/json" \
  -d "{\"aggregateId\":\"$AGG\",\"productId\":\"$PRODUCT_ID\",\"warehouseId\":\"WH1\",\"quantity\":3}"
```

Read side (отдельный router, ходит ТОЛЬКО в read model — `stock_balances` / `stock_movement`, никогда в `events`):

```bash
# текущий остаток по агрегату
curl -s "http://localhost:8081/stock?productId=$PRODUCT_ID"

# история движений (read model)
curl -s "http://localhost:8081/stock/movements?productId=$PRODUCT_ID"
```

Показать преподавателю разделение по таблицам:

```bash
# write side - append-only лог событий
docker compose exec postgres psql -U archuser -d stock_db \
  -c "SELECT id, aggregate_id, event_type, version, occurred_at FROM events ORDER BY version DESC LIMIT 5;"

# read side - денормализованная проекция
docker compose exec postgres psql -U archuser -d stock_db \
  -c "SELECT product_id, warehouse_id, on_hand, reserved, available FROM stock_balances;"
```

Ожидаемый результат: `events` и `stock_balances` — две разные таблицы, обновлённые одной командой. Команда ходит в `events`, query — в `stock_balances`. Это и есть CQRS-разделение write/read моделей.

Дополнительно — replay read-модели из event log (демонстрирует, что read model производный артефакт):

```bash
curl -s -X POST http://localhost:8081/admin/replay \
  -H "X-Admin-Key: changeme"
# {"ok":true,"message":"Read model rebuilt from event log"}
```

### Шаг 6 - R6: Event Sourcing

```bash
# несколько движений, чтобы было что показать
curl -s -X POST http://localhost:8081/stock/commands/stock-in \
  -H "Content-Type: application/json" \
  -d "{\"aggregateId\":\"$AGG\",\"productId\":\"$PRODUCT_ID\",\"warehouseId\":\"WH1\",\"quantity\":5}"
curl -s -X POST http://localhost:8081/stock/commands/stock-out \
  -H "Content-Type: application/json" \
  -d "{\"aggregateId\":\"$AGG\",\"productId\":\"$PRODUCT_ID\",\"warehouseId\":\"WH1\",\"quantity\":2}"

# исправление ошибочной записи делается КОРРЕКТИРУЮЩИМ событием, не UPDATE
curl -s -X POST http://localhost:8081/stock/commands/adjustment \
  -H "Content-Type: application/json" \
  -d "{\"aggregateId\":\"$AGG\",\"productId\":\"$PRODUCT_ID\",\"warehouseId\":\"WH1\",\"quantity_delta\":-1,\"reason_code\":\"DAMAGE\",\"notes\":\"тестовая корректировка\"}"

# полный неизменяемый лог событий по агрегату
docker compose exec postgres psql -U archuser -d stock_db -c \
  "SELECT version, event_type, occurred_at FROM events WHERE aggregate_id='$AGG' ORDER BY version;"
```

Ожидаемый результат: видно append-only лог с возрастающим `version` (1, 2, 3, ...), типы событий `STOCK_IN`, `STOCK_OUT`, `ADJUSTMENT`. Никаких UPDATE/DELETE в `events` нет — только INSERT.

Снапшоты:

```bash
docker compose exec postgres psql -U archuser -d stock_db -c \
  "SELECT aggregate_id, version, created_at FROM snapshots ORDER BY created_at DESC LIMIT 3;"
```

Если по агрегату накоплено ≥`SNAPSHOT_EVERY` событий (по умолчанию 3 в `.env`), будет запись снапшота — rehydrate агрегата начинается со снапшота и доигрывает только хвост.

Optimistic concurrency:

UNIQUE-индекс `(aggregate_id, version)` гарантирует, что параллельные команды на одном агрегате не записывают одну и ту же версию: вторая транзакция получит HTTP 409, клиент повторяет команду после перечитывания агрегата.

Event store dashboard (HTML-страница самого stock-service):

Открыть http://localhost:8081/dashboard — список агрегатов; клик по агрегату показывает его поток событий в хронологическом порядке. Это «лицо» Event Sourcing.

## API и документация

OpenAPI 3.0.0 + Swagger UI поднят на каждом сервисе:

| Сервис               | Swagger UI                       | OpenAPI JSON                          |
| -------------------- | -------------------------------- | ------------------------------------- |
| product-service      | http://localhost:8080/docs       | http://localhost:8080/docs/json       |
| stock-service        | http://localhost:8081/docs       | http://localhost:8081/docs/json       |
| notification-service | http://localhost:8082/docs       | http://localhost:8082/docs/json       |

Документация генерируется из тех же zod-схем, которые используются для валидации запросов (через `@asteasolutions/zod-to-openapi`). Это единый source of truth: схема не может разъехаться с реальным контрактом, потому что одна и та же `z.object(...)` валидирует запрос и описывает OpenAPI-операцию.

## Вопросы и ответы

**Q1: Зачем Event Sourcing в складской системе?**
A1: Склад требует полного аудита: каждое движение товара должно быть неизменно зафиксировано. ES даёт append-only лог событий, из которого восстанавливается любое историческое состояние и объясняется любой текущий остаток.

**Q2: Зачем CQRS?**
A2: Команды (изменение состояния через события) и запросы (чтение денормализованной проекции) имеют разные нагрузочные и схемные требования. Разделение позволяет оптимизировать каждую сторону независимо и не смешивать инварианты агрегата с требованиями отображения.

**Q3: Как система обрабатывает гонку при одновременных командах на одном агрегате?**
A3: Оптимистическая конкурентность через `UNIQUE(aggregate_id, version)`: команда читает текущую версию агрегата, пишет событие с `version+1`; если другая транзакция успела раньше, INSERT нарушает уникальное ограничение → HTTP 409, клиент повторяет после перечитывания агрегата.

**Q4: Как исправить ошибочную запись движения?**
A4: Новым корректирующим событием (например, `ADJUSTMENT` с `reason_code=DAMAGE`), а не UPDATE/DELETE по `events`. События неизменны, audit trail сохраняется в полном виде.

**Q5: Что произойдёт если notification-service упадёт и перезапустится?**
A5: Очередь `stock.low.notifications` объявлена durable, сообщения персистированы на брокере. При перезапуске consumer возобновляет потребление с последнего unack'ed сообщения; невалидные сообщения уходят в DLX, а не в бесконечный requeue. Ничего не теряется.

**Q6: Как проверить, что мониторинг работает для всех трёх сервисов?**
A6: `http://localhost:9090/targets` показывает все три сервиса в состоянии UP; Grafana-дашборды отображают живые данные с каждого сервиса; `curl /actuator/prometheus` на каждом порту возвращает метрики Prometheus-формата с service-специфичными именами (`cache_requests_total`, `stock_commands_total`, `stock_events_consumed_total`, `low_stock_alerts_total`).

## Структура проекта

```
archfinal/
├── product-service/          # каталог товаров, cache-aside
│   ├── src/
│   │   ├── index.ts          # express bootstrap + /docs + /actuator/prometheus
│   │   ├── routes/           # products.router.ts
│   │   ├── repositories/     # product.repo.ts (cache-aside)
│   │   ├── schemas/          # product.schema.ts (zod + OpenAPI)
│   │   └── metrics/          # registry.ts (cache_requests_total)
│   ├── Dockerfile
│   └── package.json
├── stock-service/            # CQRS + Event Sourcing
│   ├── src/
│   │   ├── index.ts
│   │   ├── routes/           # commands.router.ts, query.router.ts, admin.router.ts, dashboard.router.ts
│   │   ├── domain/           # stockAggregate.ts, eventSchemas.ts, errors.ts
│   │   ├── read/             # projector.ts, readModels.ts
│   │   ├── messaging/        # publisher.ts (stock.low → RabbitMQ)
│   │   ├── openapi.ts        # 15 paths, 17 reusable schemas
│   │   └── metrics/          # stock_commands_total, stock_events_published_total, projection_lag_seconds
│   ├── Dockerfile
│   └── package.json
├── notification-service/     # consumer stock.low → SMTP
│   ├── src/
│   │   ├── index.ts
│   │   ├── consumer.ts       # RabbitMQ consumer + DLX
│   │   ├── email.ts          # SMTP в Mailpit
│   │   ├── openapi.ts
│   │   └── metrics/          # stock_events_consumed_total, low_stock_alerts_total
│   ├── Dockerfile
│   └── package.json
├── shared-contracts/         # METRIC_NAMES, общие константы
├── observability/
│   ├── prometheus.yml        # scrape config
│   ├── alert_rules.yml
│   ├── alertmanager.yml      # SMTP в Mailpit
│   ├── grafana/provisioning/ # datasource + 3 dashboards
│   └── rabbitmq/enabled_plugins   # rabbitmq_prometheus
├── infra/
│   └── postgres-init.sql     # создаёт product_db и stock_db + DDL
├── scripts/
├── docker-compose.yml        # 10 контейнеров
├── .env                      # пароли и порты (не коммитится)
└── README.md
```

## Troubleshooting

**1. Сервис застрял в состоянии `starting`.**
Проверить логи: `docker compose logs <service> --tail=50`. Если видно `ECONNREFUSED`, скорее всего инфраструктура (postgres / rabbitmq) ещё не прошла healthcheck. Подождать 10-15 секунд: `depends_on: condition: service_healthy` сам поднимет приложение, когда зависимость станет healthy. В крайнем случае: `docker compose restart <service>`.

**2. В логах product-service не видно `cache hit`.**
Возможные причины: Redis не запущен (`docker compose ps redis` должен быть `healthy`), или продукт удалён между запросами. Проверить: `docker compose logs product-service --tail=30 | grep cache`. Если кеш не отвечает: `docker compose restart redis && docker compose restart product-service`.

**3. Swagger UI отдаёт 500 или пустую страницу.**
Скорее всего сервис ещё не закончил bootstrap (старт ~3-5 сек после healthy). Подождать и обновить. Если /docs работает, а /docs/json возвращает HTML — порядок mount'а нарушен (см. `src/index.ts`: `/docs/json` должен быть зарегистрирован ДО `swaggerUi.serve`).

**4. `stock.low` не появляется в notification-service.**
Проверить, что остаток действительно пересёк порог `LOW_STOCK_THRESHOLD=10` СВЕРХУ ВНИЗ (alert не сработает, если изначально остаток уже был ≤10 — нужен переход с `>threshold` к `<=threshold`). Сбросить состояние: `docker compose down -v && docker compose up -d --build`, затем повторить шаг 3 сценария защиты.

**5. Grafana показывает «No data».**
Дашборды смотрят на Prometheus как datasource — убедиться, что в `http://localhost:9090/targets` все три target'а в состоянии UP. Если нет — `docker compose restart prometheus`. Если есть, но в Grafana пусто: метрики появляются только после первого вызова соответствующего endpoint'а (сначала сходить curl'ом, потом смотреть Grafana).
