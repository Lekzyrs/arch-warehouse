import { appendEvent, getEvents } from "../repositories/eventStore";
import type {
  EventPayload,
  StockAggregateState,
  StockEvent,
  StockInPayload,
} from "./eventSchemas";
import { ConflictError } from "./errors";

// pure начальное состояние. version=0 = ни одного события не применено
export const emptyState: StockAggregateState = {
  on_hand: 0,
  reserved: 0,
  version: 0,
};

// pure fold. неизвестный event_type - state без изменений (forward-compat)
// STOCK_OUT и ADJUSTMENT кейсы добавляются в Plan 03-02
export function apply(
  state: StockAggregateState,
  event: StockEvent,
): StockAggregateState {
  switch (event.event_type) {
    case "STOCK_IN": {
      const p = event.payload as StockInPayload;
      return {
        ...state,
        on_hand: state.on_hand + p.quantity,
        version: event.version,
      };
    }
    default:
      return state;
  }
}

// pure валидация. STOCK_IN в scope 03-01 всегда валиден (нет инвариантов)
// STOCK_OUT и ADJUSTMENT guards добавляются в Plan 03-02
export function decide(
  _state: StockAggregateState,
  _command: { type: string; [key: string]: unknown },
): void {
  // no-op в 03-01
}

// rehydrate по логу событий. snapshot fast-path добавляется в Plan 03-03
export async function loadAggregate(
  aggregateId: string,
): Promise<{ state: StockAggregateState; nextVersion: number }> {
  const events = await getEvents(aggregateId, 0);
  const state = events.reduce(apply, emptyState);
  const nextVersion =
    events.length === 0 ? 1 : events[events.length - 1].version + 1;
  return { state, nextVersion };
}

// append по одному с проверкой версии. PG 23505 (unique_violation) -> ConflictError (HTTP 409)
export async function appendEvents(
  aggregateId: string,
  newEvents: Array<{ event_type: string; payload: EventPayload }>,
  startVersion: number,
): Promise<StockEvent[]> {
  const appended: StockEvent[] = [];
  for (let i = 0; i < newEvents.length; i++) {
    const e = newEvents[i];
    try {
      const row = await appendEvent({
        aggregate_id: aggregateId,
        version: startVersion + i,
        event_type: e.event_type,
        payload: e.payload,
      });
      appended.push(row);
    } catch (err) {
      // 23505 = PostgreSQL unique_violation на (aggregate_id, version)
      if ((err as { code?: string }).code === "23505") {
        throw new ConflictError(
          `Version conflict on aggregate ${aggregateId}`,
        );
      }
      throw err;
    }
  }
  return appended;
}
