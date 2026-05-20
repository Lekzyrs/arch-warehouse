import { appendEvent, getEvents } from "../repositories/eventStore";
import type {
  AdjustmentPayload,
  EventPayload,
  StockAggregateState,
  StockEvent,
  StockInPayload,
  StockOutPayload,
} from "./eventSchemas";
import { ConflictError, DomainError } from "./errors";

const VALID_REASON_CODES = ["CYCLE_COUNT", "DAMAGE", "LOSS"] as const;

// pure начальное состояние. version=0 = ни одного события не применено
export const emptyState: StockAggregateState = {
  on_hand: 0,
  reserved: 0,
  version: 0,
};

// pure fold. неизвестный event_type - state без изменений (forward-compat)
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
    case "STOCK_OUT": {
      const p = event.payload as StockOutPayload;
      return {
        ...state,
        on_hand: state.on_hand - p.quantity,
        version: event.version,
      };
    }
    case "ADJUSTMENT": {
      const p = event.payload as AdjustmentPayload;
      return {
        ...state,
        on_hand: state.on_hand + p.quantity_delta,
        version: event.version,
      };
    }
    default:
      return state;
  }
}

// pure валидация. STOCK_IN валиден на zod-уровне (positive quantity)
// STOCK_OUT: available = on_hand - reserved (ES-03)
// ADJUSTMENT: reason_code из enum (ES-04). zod ловит первым, decide - second-line
export function decide(
  state: StockAggregateState,
  command: { type: string; [key: string]: unknown },
): void {
  switch (command.type) {
    case "STOCK_OUT": {
      const available = state.on_hand - state.reserved;
      const requested = command.quantity as number;
      if (requested > available) {
        throw new DomainError(
          `Insufficient stock: available=${available}, requested=${requested}`,
        );
      }
      return;
    }
    case "ADJUSTMENT": {
      const reason = command.reason_code as string | undefined;
      if (!reason || !VALID_REASON_CODES.includes(reason as never)) {
        throw new DomainError(
          "Invalid reason_code: must be CYCLE_COUNT, DAMAGE, or LOSS",
        );
      }
      return;
    }
    default:
      // STOCK_IN и неизвестные типы - no-op
      return;
  }
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
