import {
  appendEvent,
  getEvents,
  getLatestSnapshot,
  saveSnapshot,
} from "../repositories/eventStore";
import type {
  AdjustmentPayload,
  CommitReservationPayload,
  EventPayload,
  ReleasePayload,
  ReservePayload,
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
    case "RESERVE": {
      const p = event.payload as ReservePayload;
      return {
        ...state,
        reserved: state.reserved + p.quantity,
        version: event.version,
      };
    }
    case "RELEASE": {
      const p = event.payload as ReleasePayload;
      return {
        ...state,
        reserved: Math.max(0, state.reserved - p.quantity),
        version: event.version,
      };
    }
    case "COMMIT_RESERVATION": {
      const p = event.payload as CommitReservationPayload;
      return {
        ...state,
        on_hand: state.on_hand - p.quantity,
        reserved: Math.max(0, state.reserved - p.quantity),
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
    case "RESERVE": {
      // WH-02: available = on_hand - reserved; нельзя резервировать больше доступного
      const available = state.on_hand - state.reserved;
      const requested = command.quantity as number;
      if (requested > available) {
        throw new DomainError(
          `Insufficient available stock: available=${available}, requested=${requested}`,
        );
      }
      return;
    }
    case "RELEASE": {
      const requested = command.quantity as number;
      if (requested > state.reserved) {
        throw new DomainError(
          `Cannot release more than currently reserved: reserved=${state.reserved}, requested=${requested}`,
        );
      }
      return;
    }
    case "COMMIT_RESERVATION": {
      const requested = command.quantity as number;
      if (requested > state.reserved) {
        throw new DomainError(
          `Cannot commit more than currently reserved: reserved=${state.reserved}, requested=${requested}`,
        );
      }
      // defensive: reserve guard уже должен был это поймать, но не доверяем
      if (requested > state.on_hand) {
        throw new DomainError(
          `Cannot commit more than on_hand: on_hand=${state.on_hand}, requested=${requested}`,
        );
      }
      return;
    }
    default:
      // STOCK_IN и неизвестные типы - no-op
      return;
  }
}

// rehydrate. snapshot fast-path (ES-06): snapshot + tail events эквивалентны full replay
export async function loadAggregate(
  aggregateId: string,
): Promise<{ state: StockAggregateState; nextVersion: number }> {
  const snap = await getLatestSnapshot(aggregateId);
  const baseVersion = snap?.version ?? 0;
  const baseState = snap?.state ?? emptyState;
  const tail = await getEvents(aggregateId, baseVersion);
  const state = tail.reduce(apply, baseState);
  const nextVersion =
    tail.length === 0 ? baseVersion + 1 : tail[tail.length - 1].version + 1;
  return { state, nextVersion };
}

// append по одному с проверкой версии. PG 23505 (unique_violation) -> ConflictError (HTTP 409)
// после успешного append если newVersion % SNAPSHOT_EVERY === 0 - пишем snapshot (best-effort)
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

  // snapshot trigger. SNAPSHOT_EVERY=50 по умолчанию, для defense ставится =3
  const SNAPSHOT_EVERY = Number.parseInt(
    process.env.SNAPSHOT_EVERY ?? "50",
    10,
  );
  const newVersion = appended[appended.length - 1].version;
  if (newVersion % SNAPSHOT_EVERY === 0) {
    try {
      // re-call getLatestSnapshot - не используем stale outer-scope (T-03-13)
      const snap = await getLatestSnapshot(aggregateId);
      const tail = await getEvents(aggregateId, snap?.version ?? 0);
      const foldedState = tail.reduce(apply, snap?.state ?? emptyState);
      await saveSnapshot(aggregateId, newVersion, foldedState);
      console.log(
        `[stock-service] snapshot saved aggregate=${aggregateId} version=${newVersion}`,
      );
    } catch (e) {
      // T-03-14: snapshot failure не блокирует уже committed events
      console.error("[stock-service] snapshot write failed:", e);
    }
  }

  return appended;
}
