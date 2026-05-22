import { Router, type Request, type Response } from "express";
import { pool } from "../config/db";
import { loadAggregate } from "../domain/stockAggregate";
import type { StockAggregateState } from "../domain/eventSchemas";
import {
  type AggregateRow,
  type DetailEventRow,
  type RecentEventRow,
  type SnapshotRow,
  renderAggregatePage,
  renderDashboard,
} from "../views/dashboard.html";

// агрегатный список: GROUP BY aggregate_id, верх стека по последнему событию.
// колонки совпадают с AggregateRow интерфейсом в dashboard.html.ts
const AGGREGATE_LIST_SQL = `
  SELECT
    aggregate_id,
    MAX(event_type) AS last_event_type,
    COUNT(*)::int AS event_count,
    MAX(version) AS last_version,
    MAX(occurred_at) AS last_event_time
  FROM events
  GROUP BY aggregate_id
  ORDER BY last_event_time DESC
`;

// глобальная лента последних 20 событий по всем агрегатам
const RECENT_EVENTS_SQL = `
  SELECT aggregate_id, version, event_type, occurred_at
  FROM events
  ORDER BY occurred_at DESC
  LIMIT 20
`;

// per-aggregate event stream (detail page). $1 = aggregate_id
const AGGREGATE_EVENTS_SQL = `
  SELECT version, event_type, payload, occurred_at
  FROM events
  WHERE aggregate_id = $1
  ORDER BY version ASC
`;

// per-aggregate snapshots (detail page). $1 = aggregate_id, новые сверху
const AGGREGATE_SNAPSHOTS_SQL = `
  SELECT version, state, created_at
  FROM snapshots
  WHERE aggregate_id = $1
  ORDER BY version DESC
`;

export const dashboardRouter = Router();

// GET /dashboard - index страница: список агрегатов + лента последних событий.
// обе query статичны, user input не подставляется - инъекция исключена.
// пустое состояние: 200 с разметкой "no aggregates yet", не 500.
dashboardRouter.get("/", async (_req: Request, res: Response) => {
  try {
    const aggResult = await pool.query<AggregateRow>(AGGREGATE_LIST_SQL);
    const eventsResult = await pool.query<RecentEventRow>(RECENT_EVENTS_SQL);

    // pg отдаёт COUNT(*)::int как number в node-pg для int4 - cast не нужен,
    // но для надёжности приводим явно (некоторые версии возвращают bigint строкой)
    const aggregates: AggregateRow[] = aggResult.rows.map((row) => ({
      aggregate_id: row.aggregate_id,
      last_event_type: row.last_event_type,
      event_count: Number(row.event_count),
      last_version: Number(row.last_version),
      last_event_time: row.last_event_time,
    }));

    const recentEvents: RecentEventRow[] = eventsResult.rows.map((row) => ({
      aggregate_id: row.aggregate_id,
      version: Number(row.version),
      event_type: row.event_type,
      occurred_at: row.occurred_at,
    }));

    const html = renderDashboard(aggregates, recentEvents);
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.status(200).send(html);
  } catch (err) {
    console.log("[stock-service] dashboard error:", err);
    res
      .status(500)
      .send("<h1>Dashboard error</h1><pre>" + String(err) + "</pre>");
  }
});

// GET /dashboard/aggregate/:id - detail страница: event stream + snapshots +
// текущий folded state. путь /aggregate/:id, потому что anchor href из index
// уже указывает на /dashboard/aggregate/${id} (см. renderAggregateRow).
// non-existent id - 200 c empty-state, не 404 и не 500.
dashboardRouter.get(
  "/aggregate/:id",
  async (req: Request, res: Response) => {
    const aggregateId = req.params.id;
    try {
      // параметризованные SELECT - $1 = aggregateId, никакой интерполяции
      const eventsResult = await pool.query<DetailEventRow>(
        AGGREGATE_EVENTS_SQL,
        [aggregateId],
      );
      const snapshotsResult = await pool.query<SnapshotRow>(
        AGGREGATE_SNAPSHOTS_SQL,
        [aggregateId],
      );

      const events: DetailEventRow[] = eventsResult.rows.map((row) => ({
        version: Number(row.version),
        event_type: row.event_type,
        payload: row.payload,
        occurred_at: row.occurred_at,
      }));

      const snapshots: SnapshotRow[] = snapshotsResult.rows.map((row) => ({
        version: Number(row.version),
        state: row.state,
        created_at: row.created_at,
      }));

      // loadAggregate использует snapshot fast-path + tail events.
      // если падает - не валим страницу, рендерим empty-state folded
      let foldedState: StockAggregateState | null = null;
      try {
        const loaded = await loadAggregate(aggregateId);
        // version=0 + ноль событий = агрегат не существует, state не показываем
        if (loaded.state.version === 0 && events.length === 0) {
          foldedState = null;
        } else {
          foldedState = loaded.state;
        }
      } catch (err) {
        console.log(
          "[stock-service] loadAggregate error for " + aggregateId + ":",
          err,
        );
        foldedState = null;
      }

      const html = renderAggregatePage(
        aggregateId,
        events,
        snapshots,
        foldedState,
      );
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.status(200).send(html);
    } catch (err) {
      console.log(
        "[stock-service] dashboard aggregate error for " + aggregateId + ":",
        err,
      );
      res
        .status(500)
        .send("<h1>Aggregate page error</h1><pre>" + String(err) + "</pre>");
    }
  },
);
