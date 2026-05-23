---
phase: 07-mini-event-store-dashboard
plan: 02
subsystem: stock-service
tags: [event-sourcing, dashboard, http, server-rendered-html, snapshot-fast-path]
requires:
  - 03-01  # events + snapshots tables DDL (columns: aggregate_id, version, event_type/payload | state, occurred_at | created_at)
  - 03-03  # loadAggregate(id) - snapshot fast-path used to compute current folded state
  - 07-01  # dashboardRouter + renderDashboard / renderAggregateRow / renderEventRow (anchor hrefs already point at /dashboard/aggregate/:id)
provides:
  - renderAggregatePage  # views/dashboard.html.ts: detail-page template with folded state + events + snapshots
  - GET /dashboard/aggregate/:id  # routes/dashboard.router.ts: parameterized event-stream + snapshots + loadAggregate
affects:
  - stock-service/src/views/dashboard.html.ts  # adds DetailEventRow, SnapshotRow, CSS_STYLES const, renderAggregatePage
  - stock-service/src/routes/dashboard.router.ts  # adds GET /aggregate/:id handler + two new SQL constants
tech-stack:
  added: []
  patterns:
    - server-side-template-strings
    - parameterized-sql ($1 binding via node-pg)
    - empty-state-safe-rendering (no 404, no 500 on missing aggregate)
    - css-styles-extracted-to-const (deduped between index and detail pages)
    - inner-try-around-loadAggregate (DB failure - empty state, not 500)
key-files:
  created: []
  modified:
    - stock-service/src/views/dashboard.html.ts
    - stock-service/src/routes/dashboard.router.ts
decisions:
  - "Route path /aggregate/:id (not /:id as the plan's action text suggested) because Plan 07-01 already ships anchor hrefs pointing at /dashboard/aggregate/${id}; using /:id would have made the index page links 404 (Rule 3 - blocking issue, see Deviations below)"
  - "Import StockAggregateState from ../domain/eventSchemas (where it's defined), not from ../domain/stockAggregate (which only re-exports the type). Keeps the template module free of any module that touches pg directly"
  - "CSS extracted to module-level CSS_STYLES const and reused by renderDashboard and renderAggregatePage - eliminates style duplication and guarantees both pages look identical on defense screenshots"
  - "loadAggregate wrapped in inner try/catch separate from the outer try - DB error inside loadAggregate degrades to empty-state folded view (200), not 500. Outer catch only fires if the SELECT queries themselves fail"
  - "state.version === 0 AND events.length === 0 means brand-new / nonexistent aggregate - pass foldedState=null so the page shows 'aggregate state unavailable' instead of a misleading {on_hand:0,reserved:0,version:0} table"
metrics:
  duration: "~25m"
  completed: "2026-05-23"
  tasks_completed: 2
  files_created: 0
  files_modified: 2
---

# Phase 07 Plan 02: Mini Event Store Dashboard - Aggregate Detail Page Summary

`GET /dashboard/aggregate/:id` extends the dashboard router with a per-aggregate detail view rendering the full event stream (ordered by version ASC), all snapshots (version DESC), and the current folded state via `loadAggregate` (snapshot fast-path from Phase 3). Pure TypeScript template strings, no client framework, no new npm packages. The empty-state contract (200 text/html for nonexistent aggregates) is preserved end-to-end.

## What was built

- `stock-service/src/views/dashboard.html.ts` (extended):
  - Added `DetailEventRow { version, event_type, payload: unknown, occurred_at: Date }` and `SnapshotRow { version, state: unknown, created_at: Date }` interfaces, matching the events/snapshots column names from 03-01-PLAN.md verbatim
  - Extracted the inline CSS from `renderDashboard` into a module-level `CSS_STYLES` const and reused it in both pages - added `pre { white-space: pre-wrap; word-break: break-word }`, `vertical-align: top` on `td/th`, and `dl/dt/dd` rules for the folded-state definition list
  - New `formatJson(value)` helper - `JSON.stringify(value, null, 2)` with the result passed through `htmlEscape` so even `<` or `&` inside JSON payloads can never escape the `<pre>` envelope
  - Exported `renderAggregatePage(id, events, snapshots, foldedState)` returning a full HTML document with: back-link to `/dashboard`, `<h1>Aggregate: {id}</h1>`, folded-state `<dl>` (or "aggregate state unavailable" if `foldedState === null`), event-stream table (Version, Event Type, Payload as `<pre>` formatted JSON, Time), snapshots table (Version, State as `<pre>` formatted JSON, Created At). Empty-state notes ("No events for this aggregate", "No snapshots yet") rendered below each empty table
  - All prior exports (`renderDashboard`, `renderAggregateRow`, `renderEventRow`, `AggregateRow`, `RecentEventRow`) preserved and continue to pass Plan 07-01's smoke tests
- `stock-service/src/routes/dashboard.router.ts` (extended):
  - Two new module-level SQL constants: `AGGREGATE_EVENTS_SQL` (`SELECT version, event_type, payload, occurred_at FROM events WHERE aggregate_id = $1 ORDER BY version ASC`) and `AGGREGATE_SNAPSHOTS_SQL` (`SELECT version, state, created_at FROM snapshots WHERE aggregate_id = $1 ORDER BY version DESC`) - both parameterized, `$1` binds `req.params.id`, no string interpolation
  - New `dashboardRouter.get('/aggregate/:id', ...)` handler: runs the two parameterized `pool.query` calls; calls `loadAggregate(aggregateId)` inside its own inner try/catch (DB error inside loadAggregate logs `[stock-service] loadAggregate error for {id}:` and sets `foldedState = null`); applies the "no folded state when version=0 and no events" rule; passes everything to `renderAggregatePage`; responds `200 text/html`. Outer try/catch wraps the two SELECTs and returns a minimal 500 HTML fallback if Postgres is unreachable
  - The existing `dashboardRouter.get('/', ...)` handler is unchanged
- No changes to `stock-service/src/index.ts` - the router is already mounted at `/dashboard` from Plan 07-01, so `/dashboard/aggregate/:id` is reachable with zero registration changes

## Acceptance criteria

| Criterion | Status | Evidence |
|-----------|--------|----------|
| `renderAggregatePage('test-id', [], [], null)` returns HTML containing "Aggregate: test-id", "Back to Dashboard", "No events for this aggregate", "No snapshots yet" | PASS | tsx smoke test passed (Task 1 verify command from plan) |
| Populated case: payload `<pre>` contains JSON-escaped quotes (`&quot;quantity&quot;`), folded state shows on_hand/reserved/version `<dd>` cells | PASS | in-process express smoke test passed - 18/18 assertions |
| `renderDashboard`, `renderAggregateRow`, `renderEventRow` still exported | PASS | imports work; existing 07-01 callers unchanged |
| No client-side `<script>` tag in rendered output | PASS | template uses no script tags; `noScriptTag` assertion in smoke test passed |
| GET /dashboard/aggregate/:id with a valid aggregate returns 200 text/html containing event_type values and "Folded State" | PASS | in-process express + stubbed pool.query: `real: 200`, `real: Folded State header`, `real: STOCK_IN visible`, `real: STOCK_OUT visible` all PASS |
| GET /dashboard/aggregate/nonexistent-id-12345 returns 200 (not 404, not 500) containing "No events for this aggregate" | PASS | smoke test: `miss: 200 (not 404/500)`, `miss: empty events msg`, `miss: empty snapshots msg`, `miss: no folded state` all PASS |
| SQL queries are parameterized (`pool.query(SQL, [req.params.id])`, `$1` used, no string interpolation) | PASS | `grep -c '\$1'` = 5 (was >= 2 required); `grep -E '(events\|snapshots).*\$\{'` = 0 matches |
| Payload column renders as formatted JSON inside `<pre>` tags | PASS | smoke test regex `/<pre>[^<]*&quot;quantity&quot;/` matches |
| Back-link to /dashboard present in response body | PASS | template emits `<a href="/dashboard">&larr; Back to Dashboard</a>` |
| Existing GET / handler unmodified (curl /dashboard still returns aggregate list) | PASS | `dashboardRouter.get('/', ...)` body unchanged byte-for-byte; smoke test `index: 200` + `index: aggregate list header` PASS |
| loadAggregate DB failure does not 500 the page | PASS | smoke test `throw: 200` + `throw: still empty-state folded` PASS - inner try/catch downgrades to foldedState=null |

## Verification

Plan's verification block specifies live curls against `http://localhost:8081`. Docker/Postgres is not available in this worktree, so the live curls are deferred to the merge environment. In their place, the route handler logic was exercised via an in-process Express smoke test with `pool.query` stubbed deterministically (same pattern Plan 07-01 used):

- Stubbed events stream for `agg-real`: STOCK_IN(qty=10) at v=1 + STOCK_OUT(qty=3) at v=2
- Stubbed snapshot for `agg-real`: `{on_hand:7, version:50}`
- `loadAggregate('agg-real')` was allowed to call through the real fold logic (`getLatestSnapshot` + `getEvents` + `apply`) - reflects: snapshot(on_hand:7) + STOCK_IN(+10) + STOCK_OUT(-3) = `{on_hand:14, reserved:0, version:2}` - smoke test asserted `>14</dd>` and `>2</dd>` in the rendered HTML, both passed
- `agg-throw` stubbed to throw inside loadAggregate - confirmed handler still returns 200 with empty-state folded view
- Nonexistent id returns empty event stream + empty snapshots + null folded state - all empty-state messages render, status is 200

Static checks (all from the plan's verification block):
- `grep -c '\$1' stock-service/src/routes/dashboard.router.ts` = `5` (>= 2 required)
- `grep -c 'dashboardRouter.get' stock-service/src/routes/dashboard.router.ts` = `2` (one `/`, one `/aggregate/:id`)
- `npx tsc --noEmit` on `stock-service` = clean (no type errors)

## Commits

| Task | Commit | Files |
|------|--------|-------|
| 1 - renderAggregatePage template (DetailEventRow, SnapshotRow, CSS_STYLES, formatJson, renderAggregatePage) | `db5532b` | stock-service/src/views/dashboard.html.ts (modified) |
| 2 - GET /dashboard/aggregate/:id route (parameterized SELECTs + loadAggregate with inner try/catch) | `f333ae9` | stock-service/src/routes/dashboard.router.ts (modified) |

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Route path corrected from `/:id` to `/aggregate/:id`**

- **Found during:** Task 2 - planning the router registration
- **Issue:** The plan's `<action>` block reads "Register `router.get('/:id', async (req, res) => { ... })`", but Plan 07-01 already ships `renderAggregateRow` / `renderEventRow` with anchor hrefs `<a href="/dashboard/aggregate/${id}">...</a>`. The router is mounted at `/dashboard` (see stock-service/src/index.ts:63). If I had registered the handler at `/:id`, the full URL would be `/dashboard/:id` and clicking any aggregate ID on the index page would 404. The plan's own verification block and acceptance criteria also use `/dashboard/aggregate/...` URLs, confirming the action text was the outlier.
- **Fix:** Registered the handler at `router.get('/aggregate/:id', ...)` so the full URL matches what the index page already links to and what the verification block tests.
- **Files modified:** stock-service/src/routes/dashboard.router.ts
- **Commit:** f333ae9

**2. [Rule 2 - Critical functionality] Inner try/catch around loadAggregate**

- **Found during:** Task 2 - implementing the handler
- **Issue:** The plan's interface block says "If loadAggregate throws (e.g. DB error): catch, set foldedState = null, log error". Without an inner try/catch, a loadAggregate failure would bubble to the outer try/catch and return a 500 - violating the empty-state contract ("non-existent aggregateId returns 200 with empty-state messages") that the plan repeatedly enforces.
- **Fix:** Wrapped the `loadAggregate` call in its own try/catch inside the handler. DB error inside loadAggregate logs `[stock-service] loadAggregate error for {id}:` and sets `foldedState = null` so the page renders "aggregate state unavailable" with a 200. Outer try/catch only handles the two top-level SELECT failures (genuine DB outage).
- **Files modified:** stock-service/src/routes/dashboard.router.ts
- **Commit:** f333ae9

## Requirements traceability

- **DASH-02** (aggregate detail page with per-id event stream): satisfied by `dashboardRouter.get('/aggregate/:id', ...)` rendering the events table ordered by `version ASC`, with each event's version, event_type, payload (JSON-formatted in `<pre>`) and occurred_at visible.
- **DASH-04** (snapshots visible per aggregate): satisfied by the snapshots table on the same page, rendering `version`, `state` (JSON-formatted in `<pre>`), and `created_at` ordered by `version DESC` so the most-recent snapshot appears first.
- **DASH-05** (current folded state shown via loadAggregate snapshot fast-path): satisfied by the `<h2>Folded State (current)</h2>` definition list - `on_hand`, `reserved`, `version` from `loadAggregate(req.params.id).state`. Inner try/catch + version-zero check downgrades to "aggregate state unavailable" when there's no aggregate, never 500.

## Threat Model Compliance

| Threat ID | Disposition | Status |
|-----------|-------------|--------|
| T-07-02-01 (Injection on `req.params.id`) | mitigate | OK - `grep -c '\$1'` = 5 in router; both detail-page SELECTs use `pool.query(SQL, [aggregateId])`; loadAggregate's internal queries (`getEvents`, `getLatestSnapshot`) also use `$1` parameter binding - never string-interpolated |
| T-07-02-02 (Information disclosure via payload `<pre>`) | accept | OK - dashboard is read-only examiner tool; payload values pass through htmlEscape inside formatJson so even `<script>` text inside payload JSON renders as escaped text, not active markup |
| T-07-02-03 (DoS via huge payload) | accept | OK - coursework-scale data; no pagination needed |
| T-07-SC (npm install tampering) | accept | OK - zero new dependencies; only extended two existing files |

## Follow-ups for downstream plans

- Plan 07-03 (if planned): a `/dashboard/replay` admin action would slot in cleanly as another router handler in `dashboard.router.ts` and could reuse `renderAggregatePage` to show the rebuilt state. The CSS_STYLES const is now ready to be imported by any third view.
- The events/snapshots tables on the detail page currently render every row - if event counts per aggregate grow large in defense seeding, a `LIMIT 200 OFFSET N` could be added without changing the template signature.

## Self-Check: PASSED

- File `stock-service/src/views/dashboard.html.ts` modified, `renderAggregatePage` exported, prior exports preserved
- File `stock-service/src/routes/dashboard.router.ts` modified, `dashboardRouter.get('/aggregate/:id', ...)` registered, existing `dashboardRouter.get('/', ...)` byte-identical
- Commit `db5532b` present in worktree git log (Task 1)
- Commit `f333ae9` present in worktree git log (Task 2)
- `grep -c '\$1' stock-service/src/routes/dashboard.router.ts` = 5 (parameterized binding confirmed)
- `grep -E '(events\|snapshots).*\$\{' stock-service/src/routes/dashboard.router.ts` = 0 (no string-interpolated SQL)
- `npx tsc --noEmit` on `stock-service` = clean
- In-process smoke test (express + stubbed pool.query) = 18/18 assertions PASS
- No client-side script tags in detail page output
- No new npm packages added (mandate honored)
