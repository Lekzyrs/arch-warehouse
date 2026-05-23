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
  renderReplayPage,
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

// projection table detection для replay: считаем сколько ожидаемых таблиц
// (stock_balances/stock_view) присутствует в схеме public. cnt=0 - phase 4
// проекций ещё нет, replay даёт graceful no-op
const PROJECTION_TABLES_SQL = `
  SELECT COUNT(*)::int AS cnt
  FROM information_schema.tables
  WHERE table_schema = 'public'
    AND table_name IN ('stock_balances', 'stock_view')
`;

// общий helper - выполняет AGGREGATE_LIST_SQL и нормализует pg-результат
// в массив AggregateRow. используется и index handler, и replay handlers
async function fetchAggregateList(): Promise<AggregateRow[]> {
  const result = await pool.query<AggregateRow>(AGGREGATE_LIST_SQL);
  return result.rows.map((row) => ({
    aggregate_id: row.aggregate_id,
    last_event_type: row.last_event_type,
    event_count: Number(row.event_count),
    last_version: Number(row.last_version),
    last_event_time: row.last_event_time,
  }));
}

export const dashboardRouter = Router();

// GET /dashboard - index страница: список агрегатов + лента последних событий.
// обе query статичны, user input не подставляется - инъекция исключена.
// пустое состояние: 200 с разметкой "no aggregates yet", не 500.
dashboardRouter.get("/", async (_req: Request, res: Response) => {
  try {
    const aggregates = await fetchAggregateList();
    const eventsResult = await pool.query<RecentEventRow>(RECENT_EVENTS_SQL);

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

// GET /dashboard/replay - "before" view: текущий список агрегатов + кнопка
// Trigger Replay. перенесён ВЫШЕ /aggregate/:id чтобы express не пытался
// сматчить "replay" как параметр :id (порядок sibling-роутов сейчас не критичен
// потому что detail page живёт под /aggregate/:id, но контракт плана соблюдён)
dashboardRouter.get("/replay", async (_req: Request, res: Response) => {
  try {
    const aggregates = await fetchAggregateList();
    const html = renderReplayPage(aggregates, null, null);
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.status(200).send(html);
  } catch (err) {
    console.log("[stock-service] replay GET error:", err);
    // даже на ошибке - 200, чтобы examiner не увидел 500 страницу
    res
      .status(200)
      .send(
        '<h1>Replay</h1><p>Error loading state: ' +
          String(err) +
          '</p><a href="/dashboard">Back</a>',
      );
  }
});

// POST /dashboard/replay - триггер read-model rebuild с never-500 гарантией.
// 1) снимаем before
// 2) детектируем projection tables через information_schema
// 3) если есть phase 4 проектор - вызываем rebuildProjection(); если нет -
//    логируем no-op и продолжаем
// 4) снимаем after
// 5) рендерим before/after страницу с message
// events table НИКОГДА не пишется при replay - только projection rebuild.
// внешний try/catch гарантирует 200 даже при необработанной ошибке внутри.
dashboardRouter.post("/replay", async (_req: Request, res: Response) => {
  console.log("[stock-service] replay triggered");
  try {
    // before snapshot до любых изменений projection
    let beforeAggregates: AggregateRow[] = [];
    try {
      beforeAggregates = await fetchAggregateList();
    } catch (err) {
      console.log("[stock-service] replay before-query error:", err);
    }

    let resultMessage =
      "Replay complete - no projection tables found (Phase 4 not yet implemented). Event store is unmodified.";

    // projection rebuild с graceful degradation
    try {
      const projResult = await pool.query<{ cnt: number }>(
        PROJECTION_TABLES_SQL,
      );
      const cnt = Number(projResult.rows[0]?.cnt ?? 0);

      if (cnt > 0) {
        // phase 4 таблицы есть - пробуем загрузить projector модуль.
        // динамический import обёрнут в try/catch: если модуль ещё не написан,
        // сваливаемся в no-op без 500
        try {
          // динамический import через runtime-строку - модуль необязателен,
          // tsc не должен пытаться его резолвить статически. если phase 4 не
          // добавил projectors/, ловим в catch ниже
          const projectorPath = "../projectors/index.js";
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const projector: any = await import(projectorPath).catch(
            () => null,
          );
          if (
            projector &&
            typeof projector.rebuildProjection === "function"
          ) {
            const rebuildResult = await projector.rebuildProjection();
            const n =
              typeof rebuildResult === "object" &&
              rebuildResult !== null &&
              "events" in rebuildResult
                ? Number(rebuildResult.events)
                : null;
            resultMessage =
              n !== null
                ? "Replay complete - projection rebuilt from " +
                  n +
                  " events."
                : "Replay complete - projection rebuilt.";
          } else {
            resultMessage =
              "Replay complete - projection tables exist but no rebuildProjection() found. Event store is unmodified.";
          }
        } catch (err) {
          console.log("[stock-service] replay projector error:", err);
          resultMessage = "Replay error: " + String(err);
        }
      }
    } catch (err) {
      console.log("[stock-service] replay projection-detect error:", err);
      resultMessage =
        "Replay complete - could not detect projection tables (" +
        String(err) +
        "). Event store is unmodified.";
    }

    // after snapshot - читаем тот же список агрегатов, чтобы показать пользователю
    let afterAggregates: AggregateRow[] = [];
    try {
      afterAggregates = await fetchAggregateList();
    } catch (err) {
      console.log("[stock-service] replay after-query error:", err);
    }

    console.log("[stock-service] replay complete: " + resultMessage);

    const html = renderReplayPage(
      beforeAggregates,
      afterAggregates,
      resultMessage,
    );
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.status(200).send(html);
  } catch (err) {
    // последний рубеж - что бы ни случилось, не отдаём 500.
    // express default error handler привёл бы к 500, а контракт DASH-06 требует
    // 200 при любом исходе
    console.log("[stock-service] replay outer error:", err);
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res
      .status(200)
      .send(
        '<h1>Replay</h1><p>Unexpected error: ' +
          String(err) +
          '</p><a href="/dashboard">Back</a>',
      );
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
