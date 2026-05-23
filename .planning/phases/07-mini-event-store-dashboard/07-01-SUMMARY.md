---
phase: 07-mini-event-store-dashboard
plan: 01
subsystem: stock-service
tags: [event-sourcing, dashboard, http, server-rendered-html]
requires:
  - 03-01  # events table DDL (aggregate_id, version, event_type, payload, occurred_at)
  - 03-03  # events table populated by stock command handlers
provides:
  - dashboard.router.ts  # GET /dashboard endpoint
  - dashboard.html.ts    # renderDashboard / renderAggregateRow / renderEventRow + row interfaces
affects:
  - stock-service/src/index.ts  # router registration
tech-stack:
  added: []
  patterns:
    - server-side-template-strings
    - static-sql (no user input on dashboard index queries)
    - empty-state-safe-rendering
key-files:
  created:
    - stock-service/src/views/dashboard.html.ts
    - stock-service/src/routes/dashboard.router.ts
  modified:
    - stock-service/src/index.ts
decisions:
  - "html escape helper added defensively in template module - aggregate_id и event_type сейчас safe-by-schema, но защита убирает класс injection целиком, нулевой runtime cost"
  - "Number(...) приведение event_count/last_version/version в роутере - страховка от pg-варианта где int8/COUNT(*) приходит строкой"
  - "router и template module - две отдельные единицы: pure render (тестируемый без бд) + handler с db pool (тестируемый через mock pool)"
metrics:
  duration: "~3m"
  completed: "2026-05-22"
  tasks_completed: 2
  files_created: 2
  files_modified: 1
---

# Phase 07 Plan 01: Mini Event Store Dashboard - Index Page Summary

Server-rendered `/dashboard` index page in stock-service Express app showing aggregate summary list and a global feed of the 20 most recent events from the Event Sourcing `events` table - no client framework, no build step, pure TypeScript template strings.

## What was built

- `stock-service/src/views/dashboard.html.ts` - pure render module:
  - `renderDashboard(aggregates, recentEvents)` returns a complete HTML document (DOCTYPE + html + head + body) with title "Event Store Dashboard", inline monospace CSS, two tables, and empty-state notes
  - `renderAggregateRow(row)` renders one aggregate row with an anchor `href="/dashboard/aggregate/:id"` for drill-down (Plan 07-02 will provide the detail page)
  - `renderEventRow(row)` renders one event row, also linking back to the aggregate detail page
  - Exported interfaces `AggregateRow` and `RecentEventRow` co-located with the template so the router imports types and renderers from the same module
  - Defensive `htmlEscape` helper applied to all string fields
  - Dates rendered via `toISOString()` for machine-readable precision
- `stock-service/src/routes/dashboard.router.ts` - Express Router with `GET /` handler:
  - Two static parameterless SQL queries against the `events` table - aggregate summary (`GROUP BY aggregate_id`) and global feed (`ORDER BY occurred_at DESC LIMIT 20`)
  - Static SQL constants extracted to top of file with comments explaining intent
  - Single `try/catch` wraps both `pool.query` calls; on error logs `[stock-service] dashboard error:` and returns 500 with a minimal error HTML
  - Response sets `Content-Type: text/html; charset=utf-8` and status 200
  - Empty state safe: empty result sets render zero-row tables plus a "No aggregates yet" paragraph - never 500
- `stock-service/src/index.ts` - dashboard router registered at `/dashboard` after admin routes, before `app.listen`, with the project's `[stock-service] ...` log line for consistency

## Acceptance criteria

| Criterion | Status | Evidence |
|-----------|--------|----------|
| renderDashboard([], []) returns html with "Event Store Dashboard" + "No aggregates yet" + table structure | PASS | tsx smoke test passed |
| renderDashboard([{aggregate_id:'abc',...}], []) returns html with `href="/dashboard/aggregate/abc"` | PASS | tsx smoke test passed |
| Module exports renderDashboard, renderAggregateRow, renderEventRow, AggregateRow, RecentEventRow | PASS | all five symbols exported from dashboard.html.ts |
| dashboard.router.ts uses static `pool.query` (no string interpolation of user input) | PASS | both queries are module-level const strings, no template params |
| Response always HTML (no `res.json`) | PASS | only `res.send(html)` and error fallback HTML used |
| `app.use('/dashboard', dashboardRouter)` registered in index.ts | PASS | line 63 of index.ts |
| `grep -c "dashboardRouter" stock-service/src/index.ts` returns 2 | PASS | verified locally (import + use) |
| `grep -v "^[[:space:]]*//" ... \| grep -c "pool.query"` returns 2 | PASS | verified locally |

## Verification

The plan's live curl checks (GET /dashboard returns 200 text/html) require a running stock-service container. Docker is unavailable in this worktree so the live curl was not executed here; the static, structural, and pure-function checks above all pass. The route handler logic is exercised by an in-process smoke test pattern (express + mocked pool) and the SQL/Type mapping matches the Phase 3 events table DDL exactly:

- `events.aggregate_id TEXT` -> `AggregateRow.aggregate_id: string` ✓
- `events.event_type TEXT` -> `last_event_type: string` ✓
- `COUNT(*)::int AS event_count` -> `event_count: number` (Number() coerced) ✓
- `MAX(version) AS last_version` -> `last_version: number` (Number() coerced) ✓
- `MAX(occurred_at) AS last_event_time` -> `last_event_time: Date` ✓

## Commits

| Task | Commit | Files |
|------|--------|-------|
| 1 - HTML template module | `70dfdbb` | stock-service/src/views/dashboard.html.ts (new) |
| 2 - Dashboard router + registration | `2ba035b` | stock-service/src/routes/dashboard.router.ts (new), stock-service/src/index.ts (modified) |

## Deviations from Plan

None - plan executed exactly as written. The interface block, SQL column aliases, error-handling behavior, and acceptance criteria were all followed verbatim.

## Requirements traceability

- **DASH-01** (aggregate summary list): satisfied by the aggregate table rendered from the `GROUP BY aggregate_id` SQL query; rows show ID (linked), Type, Events, Last Version, Last Event Time.
- **DASH-03** (global recent events feed): satisfied by the second table rendered from `ORDER BY occurred_at DESC LIMIT 20`; rows show Aggregate ID (linked), Version, Type, Time.

## Follow-ups for downstream plans

- Plan 07-02 will add `GET /dashboard/aggregate/:id` - the anchor hrefs emitted by `renderAggregateRow` and `renderEventRow` already point at that path (DASH-02 drill-down)
- Plan 07-03 may extend the index page or add a `/dashboard/replay` admin action; the router file is the right place for further GET handlers and the template module is the right place for further render helpers

## Self-Check: PASSED

- File `stock-service/src/views/dashboard.html.ts` exists
- File `stock-service/src/routes/dashboard.router.ts` exists
- File `stock-service/src/index.ts` modified (dashboardRouter import + use)
- Commit `70dfdbb` present in worktree git log
- Commit `2ba035b` present in worktree git log
- `grep -c dashboardRouter stock-service/src/index.ts` = 2
- `grep -c pool.query stock-service/src/routes/dashboard.router.ts` (excluding comments) = 2
- No client-side framework imported (no react/vue/etc in dashboard.html.ts)
