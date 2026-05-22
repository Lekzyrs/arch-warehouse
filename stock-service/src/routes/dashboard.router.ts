import { Router, type Request, type Response } from "express";
import { pool } from "../config/db";
import {
  type AggregateRow,
  type RecentEventRow,
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
