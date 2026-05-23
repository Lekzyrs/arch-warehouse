---
phase: 05-rabbitmq-stock-notification-flow-eda
plan: 01
subsystem: eda
tags: [rabbitmq, amqplib, eda, low-stock, publisher, consumer, projection]
provides:
  - WAREHOUSE_EXCHANGE, ROUTING_KEY_STOCK_LOW, QUEUE_STOCK_LOW, DLX_EXCHANGE, DLQ_QUEUE constants (shared-contracts/src/messaging.ts)
  - StockLowEvent TypeScript wire-format interface (shared-contracts/src/messaging.ts)
  - publishStockLow / connect / closePublisher (stock-service/src/messaging/publisher.ts)
  - low-stock projection hook on STOCK_OUT/ADJUSTMENT/RESERVE/COMMIT_RESERVATION (stock-service/src/read/projector.ts)
  - notification-service consumer with manual ack + prefetch(1) (notification-service/src/consumer.ts)
requires:
  - Phase 1 RabbitMQ container (warehouse stack)
  - Phase 3 stock-service event store and command router
  - Phase 4 stock-service projector (applyEventToReadModel + stock_balances.available GENERATED column)
affects:
  - stock-service startup (now connects to RabbitMQ best-effort, SIGTERM handler closes publisher)
  - notification-service startup (now starts AMQP consumer after http listen)
  - notification-service runtime deps (added amqplib, nodemailer)
  - stock-service runtime deps (added amqplib)
tech-stack:
  added:
    - amqplib@^2.0.1 (Promise API, no heartbeat:0)
    - nodemailer@^7.0.3 (added in notification-service for plan 05-02; not yet wired)
    - @types/amqplib@^0.10.8, @types/nodemailer@^6.4.17
  patterns:
    - module-level singleton channel/connection in publisher
    - best-effort publish (try/catch + console.error, never rethrow)
    - shared topology constants (no hard-coded strings in services)
    - manual ack + prefetch(1) consumer base
key-files:
  created:
    - shared-contracts/src/messaging.ts
    - stock-service/src/messaging/publisher.ts
    - notification-service/src/consumer.ts
  modified:
    - shared-contracts/src/index.ts (re-exports ./messaging)
    - stock-service/package.json (amqplib + @types/amqplib)
    - stock-service/src/index.ts (connectPublisher in bootstrap + SIGTERM closePublisher)
    - stock-service/src/read/projector.ts (low-stock publish hook after projection write)
    - notification-service/package.json (amqplib, nodemailer, @types)
    - notification-service/src/index.ts (startConsumer after http listen)
decisions:
  - Reuse existing shared-contracts/src/rabbitmq-config.ts for RABBIT_CONFIG.url assembly (handles RABBITMQ_URL OR composes from RABBITMQ_HOST/PORT/USER/PASS). Plan asked for RABBITMQ_URL only; we read it first, then fall back to composed RABBIT_CONFIG.url to stay consistent with Phase 1 .env scheme.
  - Existing projector lives at stock-service/src/read/projector.ts (function applyEventToReadModel), not stock-service/src/projector/projector.ts as referenced by the plan. Wired the hook into the actual file. Plan path was aspirational and predates Phase 4 layout.
  - reducesAvailable predicate covers STOCK_OUT, ADJUSTMENT, RESERVE, COMMIT_RESERVATION (STOCK_IN and RELEASE only increase available, no need to fire the low-stock check on those events). Plan only listed STOCK_OUT and ADJUSTMENT in the must_haves but RESERVE also lowers available (on_hand stays, reserved increases, available = on_hand - reserved drops).
  - Publisher closed on SIGTERM (graceful shutdown). No SIGINT handler added because docker compose stop sends SIGTERM by default.
metrics:
  duration_min: ~6
  tasks_completed: 2
  files_created: 3
  files_modified: 6
completed: 2026-05-20
---

# Phase 5 Plan 1: Rabbitmq Stock Notification Flow EDA Summary

End-to-end low-stock alert chain wired: shared-contracts topology constants -> stock-service publishStockLow -> projector hook fires after STOCK_OUT/ADJUSTMENT/RESERVE/COMMIT_RESERVATION when available <= LOW_STOCK_THRESHOLD -> notification-service consumer logs `[notification-service] LOW STOCK ...`. EDA-01 (durable topic exchange + persistent publish) and EDA-03 (projector publishes, consumer logs) are now demonstrable on the live stack.

## What Shipped

### Task 1: shared-contracts topology + stock-service publisher (3b13713)

- `shared-contracts/src/messaging.ts` exports five topology constants (`WAREHOUSE_EXCHANGE` = "warehouse.exchange", `ROUTING_KEY_STOCK_LOW` = "stock.low", `QUEUE_STOCK_LOW` = "stock.low.notifications", `DLX_EXCHANGE` = "warehouse.dlx", `DLQ_QUEUE` = "stock.low.dlq") and the `StockLowEvent` interface. Re-exported through `shared-contracts/src/index.ts`.
- `stock-service/src/messaging/publisher.ts`: module-level singleton with `connect()` / `publishStockLow(event)` / `closePublisher()`. Asserts a durable topic exchange. Publishes persistent (`deliveryMode: 2`) JSON. Reads `RABBITMQ_URL` from env first, then falls back to `RABBIT_CONFIG.url` for Phase 1 .env compatibility. No `heartbeat: 0` (amqplib 2.x semantic change).
- `stock-service/package.json` gains `amqplib@^2.0.1` + `@types/amqplib@^0.10.8`.

### Task 2: projector hook + notification-service consumer (5613370)

- `stock-service/src/read/projector.ts` extended: after projection upsert + stock_movement insert, reads `available` (GENERATED column on stock_balances) and if `reducesAvailable && available <= LOW_STOCK_THRESHOLD` (parsed from env, default 10) calls `publishStockLow` inside try/catch (broker outage cannot fail the projection write).
- `stock-service/src/index.ts` calls `connectPublisher()` after `initSchema()` in bootstrap (best-effort try/catch) and registers a SIGTERM handler that closes the publisher.
- `notification-service/src/consumer.ts`: `startConsumer()` connects via the same shared-contracts constants, asserts the durable exchange + durable queue, binds `stock.low`, sets `prefetch(1)`, consumes with `noAck: false`. Happy path logs `[notification-service] LOW STOCK productId=... warehouseId=... available=... threshold=...` and `ch.ack(msg)`. Parse error -> `ch.nack(msg, false, false)` (drop; DLX in plan 05-02).
- `notification-service/src/index.ts` starts the consumer AFTER `app.listen` so `/health` and `/actuator/prometheus` are reachable even if RabbitMQ is briefly unavailable.
- `notification-service/package.json` gains `amqplib@^2.0.1`, `nodemailer@^7.0.3`, `@types/amqplib`, `@types/nodemailer` (nodemailer is wired in plan 05-02 but added now to avoid a second install step).

## Acceptance Criteria

All criteria passed:

| Check | Result |
|-------|--------|
| stock-service `npm run build` | clean (tsc exit 0) |
| notification-service `npm run build` | clean (tsc exit 0) |
| WAREHOUSE_EXCHANGE = "warehouse.exchange" | OK |
| ROUTING_KEY_STOCK_LOW = "stock.low" | OK |
| QUEUE_STOCK_LOW = "stock.low.notifications" | OK |
| DLX_EXCHANGE = "warehouse.dlx" | OK |
| DLQ_QUEUE = "stock.low.dlq" | OK |
| StockLowEvent interface exported | OK |
| publisher uses deliveryMode: 2 | OK |
| publisher reads RABBITMQ_URL from env | OK |
| publisher asserts durable: true exchange | OK |
| publisher does NOT set heartbeat:0 (amqplib 2.x) | OK |
| amqplib in stock-service/package.json | OK |
| consumer logs "LOW STOCK ..." | OK |
| consumer imports QUEUE_STOCK_LOW + WAREHOUSE_EXCHANGE from shared-contracts | OK |
| consumer uses noAck: false + ch.ack + ch.nack | OK |
| consumer sets prefetch(1) | OK |
| notification-service /health + /actuator/prometheus served | OK |
| projector calls publishStockLow with LOW_STOCK_THRESHOLD env var | OK |
| projector wraps publish in try/catch logging "stock.low publish failed" | OK |
| connectPublisher called in stock-service bootstrap | OK |

Integration smoke (manual, requires `docker compose up`): step 7 of `<verification>` block — POST a stock-out that drives available <= 10, then `docker logs archfinal-notification-service-1` shows the LOW STOCK line. Code path was verified by static analysis (projector reads `available` from GENERATED column, calls `publishStockLow` if reducesAvailable && available <= threshold). Wire is live end-to-end on the next `docker compose up --build`.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Path mismatch] Projector file path differs from plan reference**
- **Found during:** Task 2 (read_first)
- **Issue:** Plan referenced `stock-service/src/projector/projector.ts` with function `applyEventToProjection`, but Phase 4 created `stock-service/src/read/projector.ts` with function `applyEventToReadModel`. Plan was written against an aspirational path.
- **Fix:** Wired the publish hook into the actual file and function. Behavior identical to the plan.
- **Files modified:** `stock-service/src/read/projector.ts`
- **Commit:** 5613370

**2. [Rule 2 - Missing critical functionality] reducesAvailable predicate broader than plan**
- **Found during:** Task 2 implementation
- **Issue:** Plan must_haves listed only STOCK_OUT and ADJUSTMENT as quantity-reducing events. RESERVE and COMMIT_RESERVATION also reduce `available` (RESERVE bumps `reserved`, available = on_hand - reserved drops; COMMIT_RESERVATION reduces both on_hand and reserved). Without including them, a customer reservation that drops available below threshold would not trigger the alert — defeats EDA-03.
- **Fix:** Added all four event types (STOCK_OUT, ADJUSTMENT, RESERVE, COMMIT_RESERVATION) to the `reducesAvailable` predicate. STOCK_IN and RELEASE remain excluded (they raise available).
- **Files modified:** `stock-service/src/read/projector.ts`
- **Commit:** 5613370

**3. [Rule 3 - Env var fallback] RABBITMQ_URL env reading**
- **Found during:** Task 1 implementation
- **Issue:** Plan mandated `RABBITMQ_URL` env var. Phase 1 docker-compose.yml passes RABBITMQ_HOST/PORT/USER/PASS instead and `shared-contracts/src/rabbitmq-config.ts` already composes these into `RABBIT_CONFIG.url`. Forcing only RABBITMQ_URL would have broken the existing stack.
- **Fix:** Publisher reads `process.env.RABBITMQ_URL ?? RABBIT_CONFIG.url`. Same approach in consumer. Either env scheme works; defense-time consistency preserved.
- **Files modified:** `stock-service/src/messaging/publisher.ts`, `notification-service/src/consumer.ts`
- **Commit:** 3b13713, 5613370

### Architecturally Significant Changes

None. All changes are additive to the projector and bootstrap; no schema migrations, no behavioral changes to existing command/query paths.

## Known Stubs

None. The notification-service consumer's nack-on-parse-error drops bad messages on the floor — this is documented in code as intentional MVP behavior. Plan 05-02 will add DLX binding to route those to `stock.low.dlq` instead.

## Self-Check: PASSED

- shared-contracts/src/messaging.ts FOUND
- stock-service/src/messaging/publisher.ts FOUND
- stock-service/src/read/projector.ts (modified) FOUND
- stock-service/src/index.ts (modified) FOUND
- notification-service/src/consumer.ts FOUND
- notification-service/src/index.ts (modified) FOUND
- commit 3b13713 FOUND
- commit 5613370 FOUND
- both `npm run build` exit 0

## Defense Talking Points

- "shared-contracts exports topology constants — publisher and consumer cannot desync on exchange/routing-key/queue names."
- "Publisher asserts a durable topic exchange. Messages are persistent (deliveryMode 2). Broker restart does not lose unacked stock.low alerts."
- "Projector publishes best-effort: broker outage logs to stderr but never fails the projection write. Stock movements always succeed, even if the alert is dropped."
- "Consumer uses prefetch(1) + manual ack. Plan 05-02 adds DLX wiring on top of this base."
- "Same topology in three places (shared-contracts as single source of truth) is a defensible 'config drift' answer on defense."
