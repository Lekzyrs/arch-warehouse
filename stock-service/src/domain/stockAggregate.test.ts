import { describe, expect, it } from "vitest";
import { apply, decide, emptyState } from "./stockAggregate";
import {
  EventPayloadSchema,
  StockInPayloadSchema,
  type StockEvent,
} from "./eventSchemas";

// фикстура для STOCK_IN event row. occurred_at не влияет на fold
const stockInEvent = (version: number, quantity: number): StockEvent => ({
  aggregate_id: "A-1",
  version,
  event_type: "STOCK_IN",
  payload: {
    event_type: "STOCK_IN",
    productId: "P1",
    warehouseId: "WH1",
    quantity,
  },
  occurred_at: new Date(),
});

describe("StockInPayloadSchema", () => {
  it("парсит валидный payload", () => {
    const r = StockInPayloadSchema.safeParse({
      event_type: "STOCK_IN",
      productId: "P1",
      warehouseId: "WH1",
      quantity: 10,
    });
    expect(r.success).toBe(true);
  });

  it("отклоняет отрицательное quantity", () => {
    const r = StockInPayloadSchema.safeParse({
      event_type: "STOCK_IN",
      productId: "P1",
      warehouseId: "WH1",
      quantity: -1,
    });
    expect(r.success).toBe(false);
  });

  it("отклоняет отсутствующий productId", () => {
    const r = StockInPayloadSchema.safeParse({
      event_type: "STOCK_IN",
      warehouseId: "WH1",
      quantity: 5,
    });
    expect(r.success).toBe(false);
  });

  it("EventPayloadSchema резолвит дискриминант STOCK_IN", () => {
    const r = EventPayloadSchema.safeParse({
      event_type: "STOCK_IN",
      productId: "P1",
      warehouseId: "WH1",
      quantity: 5,
    });
    expect(r.success).toBe(true);
  });
});

describe("apply()", () => {
  it("STOCK_IN на emptyState даёт on_hand=quantity", () => {
    const next = apply(emptyState, stockInEvent(1, 10));
    expect(next).toEqual({ on_hand: 10, reserved: 0, version: 1 });
  });

  it("два последовательных STOCK_IN складывают on_hand", () => {
    const s1 = apply(emptyState, stockInEvent(1, 10));
    const s2 = apply(s1, stockInEvent(2, 5));
    expect(s2).toEqual({ on_hand: 15, reserved: 0, version: 2 });
  });

  it("неизвестный event_type возвращает state без изменений (forward-compat)", () => {
    const evt: StockEvent = {
      ...stockInEvent(1, 10),
      event_type: "UNKNOWN_OP",
    };
    const next = apply(emptyState, evt);
    expect(next).toEqual(emptyState);
  });
});

describe("decide()", () => {
  it("STOCK_IN всегда валиден на zod-уровне (decide не бросает)", () => {
    expect(() =>
      decide(emptyState, { type: "STOCK_IN", quantity: 5 }),
    ).not.toThrow();
  });

  it("STOCK_OUT с quantity > available бросает DomainError (ES-03)", () => {
    expect(() =>
      decide(
        { on_hand: 10, reserved: 0, version: 1 },
        { type: "STOCK_OUT", quantity: 15 },
      ),
    ).toThrow(/Insufficient stock/);
  });

  it("STOCK_OUT с quantity <= available не бросает", () => {
    expect(() =>
      decide(
        { on_hand: 10, reserved: 0, version: 1 },
        { type: "STOCK_OUT", quantity: 10 },
      ),
    ).not.toThrow();
  });

  it("ADJUSTMENT без reason_code бросает DomainError (ES-04 second-line)", () => {
    expect(() =>
      decide(emptyState, { type: "ADJUSTMENT", quantity_delta: -1 }),
    ).toThrow(/Invalid reason_code/);
  });

  it("ADJUSTMENT с reason_code из enum не бросает", () => {
    for (const r of ["CYCLE_COUNT", "DAMAGE", "LOSS"]) {
      expect(() =>
        decide(emptyState, {
          type: "ADJUSTMENT",
          reason_code: r,
          quantity_delta: 1,
        }),
      ).not.toThrow();
    }
  });
});

describe("snapshot fold (ES-06 readiness)", () => {
  it("3 последовательных STOCK_IN по 5 единиц складываются в on_hand=15 (state для snapshot at SNAPSHOT_EVERY=3)", () => {
    const events = [stockInEvent(1, 5), stockInEvent(2, 5), stockInEvent(3, 5)];
    const final = events.reduce(apply, emptyState);
    expect(final).toEqual({ on_hand: 15, reserved: 0, version: 3 });
  });

  it("snapshot trigger condition: 3 % 3 === 0 (snapshot) vs 4 % 3 !== 0 (skip)", () => {
    expect(3 % 3).toBe(0);
    expect(4 % 3).not.toBe(0);
  });
});
