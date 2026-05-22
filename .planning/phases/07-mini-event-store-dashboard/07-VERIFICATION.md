---
phase: 07-mini-event-store-dashboard
verified: 2026-05-23T00:58:00Z
status: human_needed
score: 6/6 must-have requirements verified (static + render-level)
overrides_applied: 0
re_verification:
  previous_status: none
  previous_score: n/a
  gaps_closed: []
  gaps_remaining: []
  regressions: []
human_verification:
  - test: "GET /dashboard returns 200 text/html with aggregate list + recent events feed (DASH-01 + DASH-03)"
    expected: "curl -s -o /dev/null -w '%{http_code}' http://localhost:8081/dashboard returns 200; body contains 'Event Store Dashboard', an aggregate row with /dashboard/aggregate/<id> link, and a 'Recent Events (last 20)' section"
    why_human: "Requires the stock-service container, postgres, and at least one stock command appended to the events table — no Docker in this verifier session"
  - test: "GET /dashboard empty-state on a fresh events table is 200, not 500"
    expected: "After 'docker compose down -v && docker compose up -d' and BEFORE any stock command, curl http://localhost:8081/dashboard returns 200 containing 'No aggregates yet - send a stock command first.'"
    why_human: "Requires a clean Postgres volume and a running stock-service to prove the empty-state branch"
  - test: "GET /dashboard/aggregate/<real-id> shows event stream, snapshots, folded state (DASH-02 + DASH-04 + DASH-05)"
    expected: "After issuing >=1 stock command, follow the aggregate link from /dashboard; page returns 200 text/html and contains 'Folded State (current)', a dl with on_hand/reserved/version, an 'Event Stream' table whose payload cell is a <pre> JSON block, and a 'Snapshots' table (may be 'No snapshots yet.' until version >= snapshot threshold)"
    why_human: "Requires real aggregate id from the running event store; folded-state values depend on accumulated commands"
  - test: "GET /dashboard/aggregate/no-such-id is 200 with empty-state copy, not 404 / 500"
    expected: "curl -s -o /dev/null -w '%{http_code}' http://localhost:8081/dashboard/aggregate/nonexistent-id-12345 returns 200; body contains 'No events - aggregate state unavailable.' and 'No events for this aggregate.'"
    why_human: "Requires running service; route ordering against /replay must be confirmed at runtime"
  - test: "GET /dashboard/replay shows before-state table + Trigger Replay form"
    expected: "curl -s http://localhost:8081/dashboard/replay returns 200; body contains 'Replay - Event Store Rebuild', '<form method=\"POST\" action=\"/dashboard/replay\">', and a Before table"
    why_human: "Requires running stock-service; static analysis confirmed handler exists but only runtime proves it is reachable"
  - test: "POST /dashboard/replay NEVER returns 5xx (DASH-06 critical contract)"
    expected: "curl -s -o /dev/null -w '%{http_code}' -X POST http://localhost:8081/dashboard/replay returns 200; body contains both 'Before' and 'After' sections plus a message line; repeat after 'psql -c \"DROP TABLE IF EXISTS stock_balances, stock_view CASCADE\"' - still returns 200 with message containing 'no projection tables found' (case-insensitive)"
    why_human: "Requires a live Postgres in which projection tables can be dropped; never-500 cannot be observed without invoking the endpoint"
  - test: "events table is immutable across POST /dashboard/replay"
    expected: "BEFORE=$(docker exec archfinal-postgres psql -U archfinal -d archfinal -t -c 'SELECT COUNT(*) FROM events'); curl -s -X POST http://localhost:8081/dashboard/replay >/dev/null; AFTER=$(...same query...); [ \"$BEFORE\" = \"$AFTER\" ]"
    why_human: "Static analysis already confirmed the source contains no INSERT/UPDATE/DELETE/TRUNCATE against events; runtime confirmation is still expected at defense"
  - test: "Browser smoke: examiner navigates dashboard end-to-end"
    expected: "Open http://localhost:8081/dashboard in a browser; aggregate links navigate to /dashboard/aggregate/<id>; back-link returns; /dashboard/replay loads, Trigger Replay submits POST and renders before/after on one page; no console errors; HTML is server-rendered (View Source shows full document, no JS framework)"
    why_human: "Visual quality + UX flow check for defense rehearsal"
---

# Phase 7: Mini Event-Store Dashboard - Verification Report

**Phase Goal:** Server-rendered HTML dashboard at `/dashboard` for the examiner to demo Event Sourcing during oral defense - aggregate list, recent events feed, per-aggregate detail (events + snapshots + folded state), and a replay endpoint with before/after view that never returns 5xx.

**Verified:** 2026-05-23T00:58:00Z
**Status:** human_needed (static + render-level checks all PASS; runtime curl checks deferred to UAT, no Docker in this session)
**Re-verification:** No - initial verification

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| T1 | GET / returns 200 text/html with aggregate-list table and global recent-events table; empty state renders 'No aggregates yet' rather than 500 | VERIFIED (static + render smoke) | `dashboard.router.ts:81-102` handler wraps two static SELECTs in try/catch, sets `Content-Type: text/html; charset=utf-8`, status 200; render smoke `D1` confirms 'Event Store Dashboard' + 'No aggregates yet' branch fires for `renderDashboard([], [])`. **Runtime HTTP check deferred (no Docker).** |
| T2 | GET /aggregate/:id returns 200 text/html with event stream (version asc), snapshots, folded state; non-existent id is 200 with empty-state, not 404/500 | VERIFIED (static + render smoke) | `dashboard.router.ts:241-306` handler uses parameterized `$1` queries, wraps `loadAggregate` in inner try/catch (foldedState=null on error), version=0 + 0 events => foldedState=null; render smoke `D3` and `D4` confirm both branches; route path is `/aggregate/:id` per plan deviation note. **Runtime HTTP check deferred.** |
| T3 | GET /replay shows before-state aggregates + visible Trigger Replay form (method=POST action=/dashboard/replay) | VERIFIED (static + render smoke) | `dashboard.router.ts:108-125` registers GET /replay before /aggregate/:id; render smoke `D5` confirms 'Trigger Replay', '<form method="POST" action="/dashboard/replay">' present when `after === null`. **Runtime HTTP check deferred.** |
| T4 | POST /replay NEVER returns 5xx - graceful degradation when projection tables absent, outer try/catch sends 200 even on inner exceptions | VERIFIED (static) | `dashboard.router.ts:136-235`: outer try/catch at 138/221 sends `res.status(200).send(...)` on outer error; inner blocks (before-fetch, information_schema probe, dynamic import of `../projectors/index.js`, after-fetch) each have own try/catch with non-throwing fallbacks; default `resultMessage` already pre-set to 'no projection tables found' before any branch runs. `ls stock-service/src/projectors/` returns ENOENT, so dynamic import is guaranteed to fall through `.catch(() => null)` to the 'projection tables exist but no rebuildProjection()' or 'no projection tables found' branch. **Runtime curl confirmation deferred.** |
| T5 | events table is NEVER written during replay - read-only event-store contract | VERIFIED (static) | `grep -nE "INSERT|UPDATE|DELETE|TRUNCATE" stock-service/src/routes/dashboard.router.ts` returns no matches (exit 1). All 5 `pool.query` calls reference either AGGREGATE_LIST_SQL (SELECT GROUP BY), RECENT_EVENTS_SQL (SELECT ORDER BY), AGGREGATE_EVENTS_SQL (SELECT WHERE $1), AGGREGATE_SNAPSHOTS_SQL (SELECT WHERE $1), or PROJECTION_TABLES_SQL (SELECT COUNT from information_schema). Source contains zero DDL/DML against `events`. |
| T6 | No client-side framework, no build step; HTML is server-rendered in TS template strings; back-links navigable between pages | VERIFIED | `dashboard.html.ts` is pure template literals + `htmlEscape` helper; `grep -E "react|vue|svelte|angular|<script"` against the views file produces no matches. Anchor `href="/dashboard/aggregate/${id}"` (line 78, 90), back-link `<a href="/dashboard">&larr; Back to Dashboard</a>` (line 223, 334). Page is full `<!DOCTYPE html>` document, inline `<style>` only. |

**Score:** 6/6 truths verified at static + render level; 8 runtime curl/UI items deferred to human UAT.

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `stock-service/src/routes/dashboard.router.ts` | Express Router with GET /, GET /replay, POST /replay, GET /aggregate/:id; parameterized SELECTs; never-500 on POST /replay | VERIFIED | Exists, 307 lines, exports `dashboardRouter`. Handlers wired in order GET '/', GET '/replay', POST '/replay', GET '/aggregate/:id' - replay routes registered before parameterized path so Express cannot match 'replay' as :id. |
| `stock-service/src/views/dashboard.html.ts` | renderDashboard, renderAggregateRow, renderEventRow, renderAggregatePage, renderReplayPage + AggregateRow / RecentEventRow / DetailEventRow / SnapshotRow types | VERIFIED | Exists, 359 lines, all 5 functions and 4 interfaces exported (`grep "^export"` confirmed). Shared `CSS_STYLES` constant deduped across all three pages. `htmlEscape` defensively applied to id, type fields, JSON pre blocks, and replay message. |
| `stock-service/src/index.ts` | Imports dashboardRouter and mounts at /dashboard | VERIFIED | Line 10: `import { dashboardRouter } from "./routes/dashboard.router";`. Line 63: `app.use("/dashboard", dashboardRouter);`. Mounted after /admin, before app.listen. |

### Key Link Verification

| From | To | Via | Status | Details |
|------|----|----|--------|---------|
| `dashboard.router.ts` | `config/db.ts` (`pool`) | `pool.query` parameterized SELECT on events / snapshots / information_schema | WIRED | 5 `pool.query` call sites (lines 66, 84, 152, 247, 251); 2 use `$1` placeholder with `[aggregateId]` array; 3 are static no-input queries. `grep -E "VALUES.*\\\$\\{"` returns no matches. |
| `dashboard.router.ts` (GET /aggregate/:id) | `domain/stockAggregate.ts` (`loadAggregate`) | snapshot fast-path import | WIRED | Line 3: `import { loadAggregate } from "../domain/stockAggregate";`. Line 273: `const loaded = await loadAggregate(aggregateId);`. Wrapped in inner try/catch with foldedState=null fallback. |
| `dashboard.router.ts` (POST /replay) | `projectors/index.js` (optional) | dynamic `import(projectorPath).catch(() => null)` | WIRED (degrading) | Line 165-169: dynamic import of `../projectors/index.js`; directory does not exist on disk, so .catch returns null and the no-projector message is set. The runtime contract is satisfied: missing module never throws. |
| `index.ts` | `dashboard.router.ts` | `app.use('/dashboard', dashboardRouter)` | WIRED | Confirmed at line 63. |
| `dashboard.router.ts` | `views/dashboard.html.ts` | `renderDashboard`, `renderAggregatePage`, `renderReplayPage` imports | WIRED | Lines 5-13 import 5 named exports + 4 interfaces; all three render functions invoked in their respective handlers. |

### Data-Flow Trace (Level 4)

| Artifact | Data Variable | Source | Produces Real Data | Status |
|----------|---------------|--------|--------------------|--------|
| GET / handler | `aggregates`, `recentEvents` | `fetchAggregateList()` (events GROUP BY) + `pool.query(RECENT_EVENTS_SQL)` | Yes (when events table has rows) | FLOWING (runtime confirmation deferred) |
| GET /aggregate/:id | `events`, `snapshots`, `foldedState` | parameterized SELECTs on events/snapshots + `loadAggregate(aggregateId)` | Yes | FLOWING |
| GET /replay | `aggregates` | `fetchAggregateList()` | Yes | FLOWING |
| POST /replay | `beforeAggregates`, `afterAggregates`, `resultMessage` | two `fetchAggregateList()` calls bracketing optional projector rebuild | Yes; `resultMessage` always populated (default 'no projection tables found' before any branch) | FLOWING |

No hardcoded empty arrays in render call sites. No static placeholder strings flowing into user-visible cells beyond the explicit empty-state copy.

### Per-Requirement Coverage (DASH-01..06)

| Req | Description | Status | Evidence |
|-----|-------------|--------|----------|
| DASH-01 | Список агрегатов (id, тип, число событий, последняя версия, время последнего события) | PASS | AGGREGATE_LIST_SQL at `dashboard.router.ts:17-27` selects `aggregate_id, MAX(event_type) AS last_event_type, COUNT(*)::int AS event_count, MAX(version) AS last_version, MAX(occurred_at) AS last_event_time` - all 5 columns present. `renderDashboard` table thead at `dashboard.html.ts:128-135` matches: ID / Type / Events / Last Version / Last Event Time. |
| DASH-02 | Поток событий выбранного агрегата по порядку | PASS | AGGREGATE_EVENTS_SQL at `dashboard.router.ts:38-43` selects `version, event_type, payload, occurred_at WHERE aggregate_id = $1 ORDER BY version ASC`. `renderAggregatePage` thead at `dashboard.html.ts:231-238` matches. Payload cell renders as `<pre>${formatJson(row.payload)}</pre>` (line 179). |
| DASH-03 | Глобальная лента последних событий | PASS | RECENT_EVENTS_SQL at `dashboard.router.ts:30-35` `ORDER BY occurred_at DESC LIMIT 20`. `renderDashboard` renders this in a separate table 'Recent Events (last 20)' (`dashboard.html.ts:143-156`). |
| DASH-04 | Просмотр снапшотов агрегата | PASS | AGGREGATE_SNAPSHOTS_SQL at `dashboard.router.ts:46-51` selects `version, state, created_at WHERE aggregate_id = $1 ORDER BY version DESC`. `renderAggregatePage` 'Snapshots' table at `dashboard.html.ts:245-257`. State cell renders as `<pre>${formatJson(row.state)}</pre>` (line 189). |
| DASH-05 | Текущее свёрнутое состояние агрегата | PASS | `loadAggregate(aggregateId)` invoked at `dashboard.router.ts:273` (snapshot fast-path from Phase 3); foldedState rendered in dl at `dashboard.html.ts:208-212` with on_hand / reserved / version. Empty state ('No events - aggregate state unavailable.') when loadAggregate fails or stream is empty - this is acceptable degradation per plan 07-02 interfaces contract. |
| DASH-06 | Replay-эндпоинт «до/после», read-only, без auth, server-rendered | PASS (static) | GET /replay + POST /replay registered at `dashboard.router.ts:108` and `:136`; before/after tables in `renderReplayPage` at `dashboard.html.ts:269-358`; outer try/catch at `:138/:221` guarantees 200 from POST. Server-rendered HTML (no client framework). Read-only against `events` (no DDL/DML present in file). No auth middleware on router. Runtime never-500 curl deferred to UAT. |

All six DASH requirements covered by code; one is awaiting runtime curl confirmation (DASH-06's never-500 contract under live Postgres with projection tables dropped).

### Static Gate Results

| Gate | Command | Result | Status |
|------|---------|--------|--------|
| tsc clean | `cd stock-service && npx tsc --noEmit` | exit 0, no output | PASS |
| pool.query count | `grep -c "pool.query" dashboard.router.ts` | 5 (matches: index 2 + replay-detect 1 + aggregate detail 2) | PASS |
| Parameterized SQL `$1` used | `grep -nE "\$1\|\$2" dashboard.router.ts` | 2 SQL constants with WHERE aggregate_id = $1 + invocations with `[aggregateId]` | PASS |
| No SQL string interpolation | `grep -nE "VALUES.\$\{\|FROM.\$\{\|WHERE.\$\{" dashboard.router.ts` | no matches | PASS |
| No INSERT/UPDATE/DELETE/TRUNCATE on dashboard router | `grep -nE "INSERT\|UPDATE\|DELETE\|TRUNCATE" dashboard.router.ts` | no matches (exit 1) | PASS |
| Outer try/catch on POST /replay sends 200 | source inspection `dashboard.router.ts:138/221-234` | outer catch at 221 calls `res.status(200).send(...)` | PASS |
| dashboardRouter mounted at /dashboard | `grep dashboardRouter index.ts` | import line 10 + use line 63 = 2 references | PASS |
| Route ordering: GET /replay before GET /aggregate/:id | source inspection lines 108 (replay GET) / 136 (replay POST) / 241 (aggregate detail) | replay handlers precede :id parameter route - Express cannot misroute 'replay' as id (and the path is /aggregate/:id, not /:id, so the deviation makes ordering non-critical but the plan contract is still honored) | PASS |
| No debt markers in modified files | `grep -nE "TBD\|FIXME\|XXX\|TODO\|HACK\|PLACEHOLDER" dashboard.router.ts views/dashboard.html.ts` | no matches | PASS |
| No client framework / no build step | `grep -E "react\|vue\|svelte\|<script" dashboard.html.ts` | no matches; only inline `<style>` and template literals | PASS |

### Behavioral Spot-Checks (render functions, no Docker required)

| Behavior | Command | Result | Status |
|----------|---------|--------|--------|
| renderDashboard empty-state branch | `npx tsx /tmp/dash-smoke.ts` -> D1 | 'Event Store Dashboard' + 'No aggregates yet' present | PASS |
| renderDashboard populated link + type | D2 | `/dashboard/aggregate/abc` href + 'STOCK_IN' present | PASS |
| renderAggregatePage empty-state | D3 | 'Aggregate: test-id' + 'Back to Dashboard' + 'No events for this aggregate' + 'No snapshots yet' present | PASS |
| renderAggregatePage populated folded state + pre | D4 | 'STOCK_IN' + `<pre>` + 'on_hand' + '5' present | PASS |
| renderReplayPage before-only shows Trigger Replay | D5 | 'Trigger Replay' + form action present + 'No aggregates before replay' present | PASS |
| renderReplayPage after-state hides form + escapes message | D6 | 'Before' + 'After' present, 'Trigger Replay' absent, '`done &lt;b&gt;x&lt;/b&gt;`' (escaped) present | PASS |

Note: HTTP-level spot-checks (curl /dashboard, curl -X POST /dashboard/replay) are deferred to UAT because no Docker is available in this session. The render-function smoke tests confirm every code path the HTTP handlers ultimately call.

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
|------|------|---------|----------|--------|
| - | - | none | - | none |

No debt markers (TBD/FIXME/XXX/TODO/HACK/PLACEHOLDER), no commented-out future code, no `return null` empty handlers, no hardcoded `[]` flowing to render call sites beyond explicit empty-state copy.

### Plan Deviation Note

The aggregate detail route is mounted at `/dashboard/aggregate/:id`, not the `/dashboard/:id` shape suggested by Plan 07-02's interfaces block. This deviation is internally consistent: `renderAggregateRow` / `renderEventRow` in `dashboard.html.ts:78,90` emit `href="/dashboard/aggregate/${id}"`, so anchors and the route definition agree. The deviation removes any conflict between `/replay` and `/:id`, making route ordering non-critical (though the plan ordering is still respected). This is the deviation flagged in the verifier brief and is acceptable - DASH-02/04/05 are still satisfied by the same handler.

### Human Verification Required

8 items require runtime testing under `docker compose up` - see frontmatter `human_verification` for exact commands. Summary:

1. **GET /dashboard 200 + populated tables** - DASH-01 + DASH-03 visual verification.
2. **GET /dashboard empty-state 200, not 500** - fresh volume, no commands sent.
3. **GET /dashboard/aggregate/<real-id> 200 + folded state + JSON pre** - DASH-02 + DASH-04 + DASH-05 visual.
4. **GET /dashboard/aggregate/nonexistent 200, not 404/500** - graceful empty-state.
5. **GET /dashboard/replay 200 + Trigger Replay form** - DASH-06 entry point.
6. **POST /dashboard/replay 200 under all conditions** including after `DROP TABLE stock_balances, stock_view CASCADE` - the never-500 critical contract of plan 07-03.
7. **events table COUNT identical before/after POST /replay** - immutability proof in vivo.
8. **End-to-end browser flow** - examiner UX rehearsal for defense.

### Gaps Summary

No structural gaps. Codebase delivers DASH-01..06 in source. The only items keeping status from `passed` to `human_needed` are the runtime / browser confirmations that cannot run without Docker - the orchestrator explicitly deferred those to UAT.

---

## Overall Verdict

**Static and render-level: PASS for all six DASH requirements.**

- All 5 required exports present in `dashboard.html.ts`; all 4 expected HTTP routes (GET /, GET /replay, POST /replay, GET /aggregate/:id) present in `dashboard.router.ts` and wired into Express via `index.ts`.
- Parameterized SQL throughout; zero mutating SQL against `events`; outer try/catch on POST /replay guarantees 200 even under nested exceptions; dynamic projector import fails closed.
- `npx tsc --noEmit` clean.
- Render functions smoke-tested out-of-process: empty-state, populated, folded-state, JSON pre formatting, replay before/after, and HTML escaping of replay message all verified.

**Runtime curl + browser UAT deferred** (no Docker in this session). The 8 human-verification items above are the entire residual surface; once they pass under a live stack, this phase can be marked closed.

_Verified: 2026-05-23T00:58:00Z_
_Verifier: Claude (gsd-verifier)_
