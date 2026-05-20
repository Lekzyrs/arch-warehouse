import { pool } from "../config/db";
import type {
  EventPayload,
  StockAggregateState,
  StockEvent,
} from "../domain/eventSchemas";

// все запросы через $N. конкатенация user-input в SQL запрещена (T-03-01)
// events table - append-only, только INSERT/SELECT. UPDATE/DELETE запрещены (T-03-02, ES-01)

const SELECT_AFTER =
  "SELECT aggregate_id, version, event_type, payload, occurred_at FROM events WHERE aggregate_id = $1 AND version > $2 ORDER BY version ASC";

const INSERT_EVENT =
  "INSERT INTO events (aggregate_id, version, event_type, payload) VALUES ($1, $2, $3, $4) RETURNING aggregate_id, version, event_type, payload, occurred_at";

// загрузка событий после версии (для snapshot fast-path в 03-03). default 0 = все
export async function getEvents(
  aggregateId: string,
  afterVersion = 0,
): Promise<StockEvent[]> {
  const { rows } = await pool.query<StockEvent>(SELECT_AFTER, [
    aggregateId,
    afterVersion,
  ]);
  return rows;
}

// одиночный append. unique_violation (23505) пробрасываем наверх для маппинга в ConflictError
export async function appendEvent(
  event: Omit<StockEvent, "occurred_at">,
): Promise<StockEvent> {
  const { rows } = await pool.query<StockEvent>(INSERT_EVENT, [
    event.aggregate_id,
    event.version,
    event.event_type,
    event.payload as EventPayload,
  ]);
  return rows[0];
}

// последний snapshot или null если нет ни одного. fast-path в loadAggregate (ES-06)
export async function getLatestSnapshot(
  aggregateId: string,
): Promise<{ version: number; state: StockAggregateState } | null> {
  const { rows } = await pool.query<{
    aggregate_id: string;
    version: number;
    state: StockAggregateState;
    created_at: Date;
  }>(
    "SELECT aggregate_id, version, state, created_at FROM snapshots WHERE aggregate_id = $1 ORDER BY version DESC LIMIT 1",
    [aggregateId],
  );
  if (rows.length === 0) return null;
  return { version: rows[0].version, state: rows[0].state };
}

// идемпотентный insert. ON CONFLICT DO NOTHING - повторный save той же version - no-op
export async function saveSnapshot(
  aggregateId: string,
  version: number,
  state: StockAggregateState,
): Promise<void> {
  await pool.query(
    "INSERT INTO snapshots (aggregate_id, version, state) VALUES ($1, $2, $3) ON CONFLICT (aggregate_id, version) DO NOTHING",
    [aggregateId, version, state],
  );
}
