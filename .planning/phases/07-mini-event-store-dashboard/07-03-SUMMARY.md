---
phase: 07-mini-event-store-dashboard
plan: 03
subsystem: stock-service
tags: [event-sourcing, dashboard, http, server-rendered-html, replay, graceful-degradation]
requires:
  - 03-01  # events table DDL (read-only during replay)
  - 03-03  # events table populated by stock command handlers
  - 07-01  # dashboardRouter, AGGREGATE_LIST_SQL, AggregateRow, renderAggregateRow
  - 07-02  # CSS_STYLES const, renderAggregatePage (sibling page conventions)
provides:
  - renderReplayPage           # views/dashboard.html.ts: before/after replay template
  - GET /dashboard/replay      # routes/dashboard.router.ts: "before" view + Trigger button
  - POST /dashboard/replay     # routes/dashboard.router.ts: never-500 rebuild + before/after page
affects:
  - stock-service/src/views/dashboard.html.ts        # appended renderReplayPage + replay-specific CSS
  - stock-service/src/routes/dashboard.router.ts     # added PROJECTION_TABLES_SQL, fetchAggregateList helper, GET/POST /replay handlers
tech-stack:
  added: []
  patterns:
    - never-500-outer-try-catch          # GET и POST /replay - оба обёрнуты внешним try/catch, любая ошибка превращается в 200 fallback
    - information-schema-probe           # обнаружение projection tables до rebuild, без assumption что phase 4 уже выполнен
    - graceful-degradation               # missing module / missing table / db error - все ветки рендерят 200 с понятным сообщением
    - dynamic-import-via-runtime-string  # ../projectors/index.js загружается через строковую переменную - tsc не требует чтобы модуль существовал
    - aggregate-list-helper-dedupe       # fetchAggregateList переиспользуется index + GET /replay + POST /replay
    - form-hide-after-replay             # форма Trigger Replay видна только когда after === null (before-state view)
    - html-escape-on-result-message      # resultMessage экранируется в renderReplayPage - даже ошибки с html-символами не могут вырваться из div
key-files:
  created: []
  modified:
    - stock-service/src/views/dashboard.html.ts
    - stock-service/src/routes/dashboard.router.ts
decisions:
  - "POST /replay rebuilds projection через dynamic import('../projectors/index.js') - модуль ещё не существует (phase 4 не реализован), import().catch(()=>null) даёт null, ветка no-op message. когда phase 4 добавит projectors/index.ts с export rebuildProjection() - replay начнёт реально rebuild без правок в dashboard.router.ts"
  - "путь к projector модулю хранится в runtime-переменной const projectorPath = '../projectors/index.js' - tsc не пытается резолвить статически, что снимает блокирующую ошибку TS2307 без @ts-ignore"
  - "fetchAggregateList helper вынесен из inline-кода GET / handler - один источник истины для AGGREGATE_LIST_SQL + Number() нормализации, переиспользован тремя обработчиками (GET /, GET /replay, POST /replay - before и after)"
  - "POST /replay использует 200 + html before/after страницу вместо 302 redirect - в плане в must_haves описаны оба варианта, выбрана 200-with-html чтобы before и after были на одной странице (лучше для defense screenshot - examiner видит сравнение мгновенно)"
  - "форма Trigger Replay рендерится только когда after === null. после rebuild страница показывает before+after+message без формы - предотвращает случайный повторный rebuild и упрощает UX defense"
  - "GET /replay и POST /replay зарегистрированы выше GET /aggregate/:id даже несмотря на то что они sibling-пути (нет prefix-коллизии) - порядок соответствует контракту плана и устойчив к будущим изменениям, если /aggregate когда-нибудь станет /:id"
  - "before и after fetch обёрнуты в собственные inner try/catch - даже если pg падает в момент снятия snapshot, replay рендерит пустые таблицы с messages, не падает в outer catch"
metrics:
  duration: "~18m"
  completed: "2026-05-23"
  tasks_completed: 2
  files_created: 0
  files_modified: 2
---

# Phase 07 Plan 03: Event Store Replay Endpoint Summary

Третий и финальный вертикальный срез event-store dashboard: `GET /dashboard/replay` рендерит "before" состояние (список агрегатов и кнопку **Trigger Replay**), `POST /dashboard/replay` запускает rebuild проекций с graceful degradation - если phase 4 ещё не добавил `stock_balances`/`stock_view` таблицы или `projectors/` модуль, POST возвращает HTTP 200 c сообщением "no projection tables found", events table при этом не модифицируется. После rebuild страница показывает обе таблицы рядом (before vs after) - examiner видит DASH-06 как одно взаимодействие в браузере.

## What was built

- `stock-service/src/views/dashboard.html.ts` (extended):
  - `renderReplayPage(before, after, message)` экспортируется как пятый render-функция модуля - сигнатура `(before: AggregateRow[], after: AggregateRow[] | null, message: string | null) => string`
  - **Before-only режим** (`after === null`): h1 "Replay - Event Store Rebuild", back-link на `/dashboard`, before-таблица с 5 колонками (ID, Type, Events, Last Version, Last Event Time), form POST `/dashboard/replay` с кнопкой **Trigger Replay**. Empty-state "No aggregates before replay" если before пустой
  - **Before+After режим** (`after !== null`): добавляется секция `<h2>After</h2>` с такой же таблицей, форма скрывается чтобы не было случайного повторного запуска
  - **Message-режим**: если `message !== null`, рендерится `<div class="replay-result"><strong>{escaped}</strong></div>` сверху. Сообщение проходит через `htmlEscape` - даже если сообщение содержит `<script>`, оно вылазит как литерал `&lt;script&gt;`
  - Reuse `CSS_STYLES` из 07-02 + 3 дополнительные правила специфичные для replay (`.replay-result`, `form`, `button`) - наследует ту же монопространственную палитру что и index и detail страницы
  - Все 5 предыдущих exports (`renderDashboard`, `renderAggregateRow`, `renderEventRow`, `renderAggregatePage`, `AggregateRow`, `RecentEventRow`, `DetailEventRow`, `SnapshotRow`) сохранены byte-identical
- `stock-service/src/routes/dashboard.router.ts` (extended):
  - **`PROJECTION_TABLES_SQL`** - module-level constant, `SELECT COUNT(*)::int AS cnt FROM information_schema.tables WHERE table_schema = 'public' AND table_name IN ('stock_balances', 'stock_view')`. Параметров нет, имена таблиц захардкожены - инъекция исключена
  - **`fetchAggregateList()`** helper - выполняет существующий `AGGREGATE_LIST_SQL` и нормализует pg-результат в `AggregateRow[]` (Number() coercion для int8/bigint). Дедуплицировал inline-логику бывшего GET / handler и заодно используется тремя новыми путями
  - **`GET /replay`** handler - `await fetchAggregateList()`, `renderReplayPage(aggregates, null, null)`, 200 text/html. Wrapper try/catch: на любую ошибку - 200 с минимальным fallback HTML (h1 + текст ошибки + back-link), никогда не 500
  - **`POST /replay`** handler - выполняет следующий контракт:
    1. `console.log('[stock-service] replay triggered')` на входе
    2. **before snapshot** через `fetchAggregateList()` в собственном try/catch (DB error - пустой массив, не валит всё)
    3. **projection detection** через `PROJECTION_TABLES_SQL` query - если cnt > 0 пробуем `await import(projectorPath)` где `projectorPath = '../projectors/index.js'` (runtime-строка чтобы tsc не пытался резолвить статически). `.catch(() => null)` гасит missing-module ошибку
    4. Если projector модуль есть и `rebuildProjection` функция экспортирована - вызываем, message = "Replay complete - projection rebuilt from {N} events." (или просто "rebuilt." если функция вернула не объект)
    5. Если projector нет - message = "Replay complete - projection tables exist but no rebuildProjection() found. Event store is unmodified."
    6. Если cnt === 0 - message = "Replay complete - no projection tables found (Phase 4 not yet implemented). Event store is unmodified."
    7. Если projection-detect query упала - message = "Replay complete - could not detect projection tables ({err}). Event store is unmodified."
    8. **after snapshot** через `fetchAggregateList()` в собственном try/catch
    9. `console.log('[stock-service] replay complete: ' + resultMessage)`
    10. `renderReplayPage(before, after, message)`, 200 text/html
  - **Outer try/catch** обёртывает весь POST handler - если что-то всё-таки не было поймано внутренними блоками, последний рубеж рендерит `<h1>Replay</h1><p>Unexpected error: {err}</p>` со статусом 200 и back-link. Это финальная гарантия never-500
  - GET `/replay` и POST `/replay` зарегистрированы **до** GET `/aggregate/:id` - формально нет коллизии префиксов (они sibling routes), но порядок соответствует IMPORTANT-директиве плана и устойчив к будущим изменениям пути
  - Events table **не модифицируется** ни одной из новых веток - replay только rebuilds проекцию (когда она существует) либо логирует no-op

## Acceptance criteria

| Criterion | Status | Evidence |
|-----------|--------|----------|
| `renderReplayPage([], null, null)` returns HTML with "Replay", "Trigger Replay", "Back to Dashboard", "No aggregates before replay" | PASS | tsx smoke test (Task 1 verify) - все 4 строки найдены, exit 0 |
| `renderReplayPage([row], [row], 'msg')` shows Before+After+message и скрывает форму | PASS | smoke test: Before/After/message найдены, Trigger Replay отсутствует |
| Message HTML-escape (`<script>alert(1)</script>` → `&lt;script&gt;...`) | PASS | smoke test: literal `<script>` отсутствует, `&lt;script&gt;` присутствует |
| All prior exports from `dashboard.html.ts` still present | PASS | dynamic import смог импортировать `renderDashboard`, `renderAggregateRow`, `renderEventRow`, `renderAggregatePage`, `renderReplayPage` |
| GET /dashboard/replay returns 200 with Trigger Replay button и before-state | PASS | in-process express smoke - status=200, body contains "Trigger Replay" и aggregate row |
| POST /dashboard/replay returns HTTP 200 (NEVER 5xx) | PASS | 4 сценария проверены: no projection tables / projection-detect throws / все queries throw / нормальный путь - все возвращают 200 |
| POST /dashboard/replay c отсутствующими projection tables - 200 + "no projection tables found" message | PASS | smoke test scenario 2 - status=200, body содержит case-insensitive "no projection tables found" |
| POST /replay response contains Before и After section headings | PASS | smoke test scenario 2 - body contains `<h2>Before</h2>` и `<h2>After</h2>` |
| Events table не модифицируется | PASS | dashboard.router.ts не содержит ни одного `INSERT`/`UPDATE`/`DELETE`/`TRUNCATE` против `events` таблицы. `grep -E 'INSERT INTO events\|UPDATE events\|DELETE FROM events\|TRUNCATE events'` возвращает 0 строк |
| GET /replay зарегистрирован выше GET /aggregate/:id | PASS | grep: line 108 /replay GET, line 136 /replay POST, line 241 /aggregate/:id GET |
| grep "information_schema" stock-service/src/routes/dashboard.router.ts >= 1 | PASS | count = 2 (SQL constant + комментарий рядом) |
| No unhandled promise rejection under any error condition | PASS | smoke test scenario 4 - "all queries throw" - сервер не упал, 200 возвращён, нет unhandledRejection в process |
| renderReplayPage не выводит client-side script tag | PASS | smoke test проверяет `/<script\b/i` - не найдено |
| Все prior exports preserved | PASS | exports: AggregateRow, RecentEventRow, DetailEventRow, SnapshotRow, renderDashboard, renderAggregateRow, renderEventRow, renderAggregatePage, renderReplayPage - 9 символов на месте |

## Verification

Plan's verification block требует live curl против `http://localhost:8081`. Docker/Postgres в worktree недоступен (нет `npm install`, нет запущенного контейнера). Live curls deferred to the merge environment. Вместо них route logic exercised через in-process Express smoke test с stub'нутым `pool.query`:

### In-process Express smoke test - 6 сценариев

| Scenario | Stub behavior | Expected | Result |
|----------|---------------|----------|--------|
| GET /replay normal | aggregate list returns 1 row | 200, "Trigger Replay" present, "agg-1" in body, no `<h2>After</h2>` | PASS |
| POST /replay - no projection tables | `cnt=0` from information_schema, aggregates return 1 row | 200, "no projection tables found" in body, Before+After both present, form hidden | PASS |
| POST /replay - projection-detect throws | `information_schema` query throws "connection refused" | 200, "could not detect projection tables" in body | PASS |
| POST /replay - all queries throw | every pool.query throws "pg pool dead" | 200 (last-resort outer catch fires) | PASS |
| GET /replay - pool throws | aggregate list throws "pg down" | 200 fallback HTML | PASS |
| Route ordering /replay vs /aggregate/:id | sanity check | GET /replay → renderReplayPage, не renderAggregatePage | PASS |

Test logs показывают все три catch-уровня срабатывают и продолжают handler-flow: `[stock-service] replay before-query error:`, `[stock-service] replay projection-detect error:`, `[stock-service] replay after-query error:` - каждый раз response остаётся 200.

### Static checks (from plan's verification block)

- `grep -c "information_schema" stock-service/src/routes/dashboard.router.ts` = **2** (>= 1 required)
- `grep -c '\$1' stock-service/src/routes/dashboard.router.ts` = **5** (existing aggregate detail bindings + replay's projection-detect query has no params, expected)
- `grep -c 'dashboardRouter\.\(get\|post\)' stock-service/src/routes/dashboard.router.ts` = **4** (GET /, GET /replay, POST /replay, GET /aggregate/:id)
- `grep -nE 'dashboardRouter\.(get\|post)\("/(replay|aggregate)' ...` подтверждает: line 108 GET /replay, line 136 POST /replay, line 241 GET /aggregate/:id - replay handlers выше aggregate detail
- `npx tsc --noEmit` на stock-service - clean exit 0 (с symlink на node_modules main-репо)

### Events immutability check

Plan требует `psql -c "SELECT COUNT(*) FROM events"` до и после POST /replay. Без живой БД делаем static-grep заместо:

- `grep -nE 'INSERT INTO events|UPDATE events|DELETE FROM events|TRUNCATE events' stock-service/src/routes/dashboard.router.ts` → 0 совпадений
- POST /replay handler читает events только через `AGGREGATE_LIST_SQL` (GROUP BY query) - ни одной mutation operation на events table в новом коде

## Commits

| Task | Commit | Files |
|------|--------|-------|
| 1 - renderReplayPage template (before/after + escaped message + form + CSS) | `00d56b3` | stock-service/src/views/dashboard.html.ts (modified) |
| 2 - GET /replay + POST /replay handlers (never-500, projection detection, dynamic projector import) | `7e3f2e2` | stock-service/src/routes/dashboard.router.ts (modified) |

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Dynamic projector import via runtime-string path**

- **Found during:** Task 2 — TypeScript compile
- **Issue:** Plan говорит `await import('../projectors/index.js')` для проверки наличия phase 4 projector. Директория `stock-service/src/projectors/` ещё не существует (phase 4 не реализован). Прямой статический import делает `tsc --noEmit` валиться с `TS2307: Cannot find module '../projectors/index.js'`. Это блокирует тип-чек, что блокирует CI и build.
- **Fix:** Путь модуля сохраняется в runtime-переменную `const projectorPath = '../projectors/index.js';` затем `await import(projectorPath)`. TypeScript не пытается резолвить динамические импорты со string-переменной - tsc прекращает требовать существования модуля. Behavior идентичный: `.catch(() => null)` всё равно ловит missing-module ошибку в runtime.
- **Files modified:** stock-service/src/routes/dashboard.router.ts
- **Commit:** 7e3f2e2

**2. [Rule 2 - Critical functionality] Inner try/catch вокруг before и after fetch**

- **Found during:** Task 2 - implementing handler
- **Issue:** Plan описывает 3 уровня try/catch: outer (всё), projection-rebuild (один), и подразумевает что before/after fetch может упасть. Без отдельных catch для `fetchAggregateList` в before и after снапшотах любая DB ошибка падает в outer catch и страница теряет частичную информацию.
- **Fix:** Каждый из двух `fetchAggregateList()` вызовов обёрнут в собственный try/catch с дефолтом в пустой массив. Если pg падает в момент before snapshot - страница рендерится с empty before, продолжает на projection step, snapshot after (тоже скорее всего упадёт но обработается). Outer catch остаётся последним рубежом, но используется редко.
- **Files modified:** stock-service/src/routes/dashboard.router.ts
- **Commit:** 7e3f2e2

**3. [Rule 2 - Refactor for reuse] `fetchAggregateList` helper extracted**

- **Found during:** Task 2 - planning что будет вызывать AGGREGATE_LIST_SQL
- **Issue:** Index handler в GET / уже выполняет `pool.query(AGGREGATE_LIST_SQL)` с inline-нормализацией. Replay handlers нужны 3 дополнительных вызова (GET /replay + POST /replay before + POST /replay after). Дублирование 6 строк × 4 раза - 24 строки шаблона на одну SQL constant.
- **Fix:** Извлёк `async function fetchAggregateList(): Promise<AggregateRow[]>` рядом с SQL constants. GET / handler упростился (теперь вызывает helper), все 3 replay-вызова единообразны.
- **Files modified:** stock-service/src/routes/dashboard.router.ts
- **Commit:** 7e3f2e2

### Decisions not in plan (but compatible)

**Strategy: 200 with html, не 302 redirect** - plan must_haves описывает обе опции ("responds HTTP 302 redirect (or 200 with a 'replay complete' message)"). Выбрал 200-with-html - examiner видит before и after на одной странице мгновенно, не нужно нажимать back и заново загружать. Это упрощает defense screenshot и оставляет URL стабильным после POST.

## Requirements traceability

- **DASH-06** (replay button + before/after view): полностью satisfied:
  - `GET /dashboard/replay` - "before" entry point с visible "Trigger Replay" form button
  - `POST /dashboard/replay` - rebuild с graceful degradation, never-500 contract, рендерит before и after таблицы рядом
  - events table read-only (нет INSERT/UPDATE/DELETE/TRUNCATE в новом коде)
  - DASH-06 demonstrable в один browser interaction - открыть /dashboard/replay, нажать button, увидеть Before vs After

## Threat Model Compliance

| Threat ID | Disposition | Status |
|-----------|-------------|--------|
| T-07-03-01 (Elevation of Privilege - unauth POST /replay) | accept | OK - dashboard intentionally no-auth для coursework, replay идемпотентен (rebuild из immutable event log), state corruption невозможен |
| T-07-03-02 (DoS - full event scan) | accept | OK - coursework scale, event count tens/hundreds, no rate-limiting needed |
| T-07-03-03 (Tampering - resultMessage в HTML) | mitigate | OK - `htmlEscape(String(message))` применяется внутри renderReplayPage перед embedding в `<div class="replay-result">`. Smoke test: literal `<script>alert(1)</script>` подаётся как message, rendered output содержит `&lt;script&gt;` - injection невозможна |
| T-07-03-04 (Tampering - TRUNCATE stock_balances) | accept | OK - projection tables денормализованы, TRUNCATE + rebuild это intended CQRS replay operation. Когда phase 4 добавит rebuildProjection() - TRUNCATE будет внутри него (не в dashboard router) |
| T-07-SC (npm install tampering) | accept | OK - 0 new npm packages, только extension двух существующих файлов |

## Follow-ups for downstream plans

- **Phase 4 hook**: когда phase 4 добавит `stock-service/src/projectors/index.ts` с `export async function rebuildProjection() { return { events: <number> }; }`, POST /dashboard/replay автоматически начнёт вызывать его без правок в dashboard.router.ts. Контракт интеграции: функция должна быть idempotent (TRUNCATE+rebuild), возвращать объект с `events` field (опционально - просто success message если null).
- **Pagination для большого event store**: если на защите будет много событий (сотни), can добавить LIMIT в `AGGREGATE_LIST_SQL` или показывать только N последних агрегатов в before/after. Сейчас coursework-scale (10-50 агрегатов) - не нужно.
- **Live curls verification** требует docker + postgres - запускается на merge environment, не в worktree. Test commands из plan's verification block ready для копи-пасты:
  ```bash
  curl -s -o /dev/null -w "%{http_code}" http://localhost:8081/dashboard/replay        # → 200
  curl -s -o /dev/null -w "%{http_code}" -X POST http://localhost:8081/dashboard/replay # → 200 (NEVER 500)
  curl -s -X POST http://localhost:8081/dashboard/replay | grep -c "Before"             # → 1
  curl -s -X POST http://localhost:8081/dashboard/replay | grep -c "After"              # → 1
  ```

## Self-Check: PASSED

- File `stock-service/src/views/dashboard.html.ts` modified, `renderReplayPage` exported, 8 prior exports preserved
- File `stock-service/src/routes/dashboard.router.ts` modified, `dashboardRouter.get('/replay')`, `dashboardRouter.post('/replay')`, `fetchAggregateList`, `PROJECTION_TABLES_SQL` added
- Commit `00d56b3` present in worktree git log (Task 1)
- Commit `7e3f2e2` present in worktree git log (Task 2)
- `grep -c information_schema stock-service/src/routes/dashboard.router.ts` = 2 (>= 1)
- `grep -c '\$1' stock-service/src/routes/dashboard.router.ts` = 5
- `grep -nE 'dashboardRouter\.(get\|post)\("/(replay|aggregate)' ...` confirms /replay (108, 136) выше /aggregate/:id (241)
- `grep -nE 'INSERT INTO events|UPDATE events|DELETE FROM events|TRUNCATE events'` = 0 совпадений (events table immutable)
- `npx tsc --noEmit` на stock-service = clean (с symlink на node_modules main-репо)
- In-process express smoke test (6 сценариев) = ALL PASS
- No client-side script tags in replay page output
- No new npm packages added (mandate honored)
