import {
  Router,
  type NextFunction,
  type Request,
  type Response,
} from "express";
import { Counter } from "prom-client";
import { z } from "zod";
import { ConflictError, DomainError } from "../domain/errors";
import {
  AdjustmentPayloadSchema,
  CommitReservationPayloadSchema,
  ReasonCode,
  ReleasePayloadSchema,
  ReservePayloadSchema,
  StockInPayloadSchema,
  StockOutPayloadSchema,
} from "../domain/eventSchemas";
import {
  appendEvents,
  decide,
  loadAggregate,
} from "../domain/stockAggregate";
import { registry } from "../metrics/registry";
import { applyEventToReadModel } from "../read/projector";

// command DTO. aggregateId = одна aggregate-stream на пару product+warehouse
const StockInCommandSchema = z.object({
  aggregateId: z.string().min(1),
  productId: z.string().min(1),
  warehouseId: z.string().min(1),
  locationId: z.string().optional(),
  quantity: z.number().int().positive(),
  performedBy: z.string().optional(),
});

const StockOutCommandSchema = z.object({
  aggregateId: z.string().min(1),
  productId: z.string().min(1),
  warehouseId: z.string().min(1),
  locationId: z.string().optional(),
  quantity: z.number().int().positive(),
  performedBy: z.string().optional(),
});

// reason_code обязателен и enum (ES-04). zod - primary layer; decide - second-line
const AdjustmentCommandSchema = z.object({
  aggregateId: z.string().min(1),
  productId: z.string().min(1),
  warehouseId: z.string().min(1),
  quantity_delta: z.number().int(),
  reason_code: ReasonCode,
  notes: z.string().optional(),
  performedBy: z.string().optional(),
});

// WH-02 reserve. reservationId - correlation key для последующего release/commit
const ReserveCommandSchema = z.object({
  aggregateId: z.string().min(1),
  productId: z.string().min(1),
  warehouseId: z.string().min(1),
  locationId: z.string().optional(),
  quantity: z.number().int().positive(),
  reservationId: z.string().min(1),
  performedBy: z.string().optional(),
});

const ReleaseCommandSchema = z.object({
  aggregateId: z.string().min(1),
  productId: z.string().min(1),
  warehouseId: z.string().min(1),
  locationId: z.string().optional(),
  quantity: z.number().int().positive(),
  reservationId: z.string().min(1),
  performedBy: z.string().optional(),
});

const CommitReservationCommandSchema = z.object({
  aggregateId: z.string().min(1),
  productId: z.string().min(1),
  warehouseId: z.string().min(1),
  locationId: z.string().optional(),
  quantity: z.number().int().positive(),
  reservationId: z.string().min(1),
  performedBy: z.string().optional(),
});

// module-level Counter. duplicate-registration ошибка если создавать в обработчике
const commandsTotal = new Counter({
  name: "stock_commands_total",
  help: "Total stock commands processed",
  labelNames: ["command_type", "result"],
  registers: [registry],
});

export const commandsRouter = Router();

// async-wrapper. без него reject из await не дойдёт до express error chain
function wrap(
  fn: (req: Request, res: Response) => Promise<unknown>,
): (req: Request, res: Response, next: NextFunction) => void {
  return (req, res, next) => {
    fn(req, res).catch(next);
  };
}

commandsRouter.post(
  "/stock-in",
  wrap(async (req, res) => {
    const parsed = StockInCommandSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ errors: parsed.error.issues });
    }
    const cmd = parsed.data;

    const { state, nextVersion } = await loadAggregate(cmd.aggregateId);

    try {
      decide(state, { type: "STOCK_IN", ...cmd });
    } catch (err) {
      if (err instanceof DomainError) {
        commandsTotal.inc({ command_type: "STOCK_IN", result: "rejected" });
        return res.status(422).json({ error: err.message });
      }
      throw err;
    }

    const payload = StockInPayloadSchema.parse({
      event_type: "STOCK_IN",
      productId: cmd.productId,
      warehouseId: cmd.warehouseId,
      locationId: cmd.locationId,
      quantity: cmd.quantity,
      performedBy: cmd.performedBy,
    });

    try {
      const appended = await appendEvents(
        cmd.aggregateId,
        [{ event_type: "STOCK_IN", payload }],
        nextVersion,
      );
      // sync projection (CQRS-03 read-your-writes). projection fail = stale read model, rethrow для 500
      try {
        for (const evt of appended) {
          await applyEventToReadModel(evt);
        }
      } catch (e) {
        console.error("[stock-service] projection failed for event:", e);
        throw e;
      }
      commandsTotal.inc({ command_type: "STOCK_IN", result: "success" });
      console.log(
        `[stock-service] STOCK_IN aggregate=${cmd.aggregateId} v=${appended[0].version}`,
      );
      return res.status(200).json({
        aggregateId: cmd.aggregateId,
        version: appended[0].version,
        event_type: "STOCK_IN",
        payload,
      });
    } catch (err) {
      if (err instanceof ConflictError) {
        commandsTotal.inc({ command_type: "STOCK_IN", result: "conflict" });
        return res.status(409).json({ error: err.message });
      }
      throw err;
    }
  }),
);

commandsRouter.post(
  "/stock-out",
  wrap(async (req, res) => {
    const parsed = StockOutCommandSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ errors: parsed.error.issues });
    }
    const cmd = parsed.data;

    const { state, nextVersion } = await loadAggregate(cmd.aggregateId);

    try {
      decide(state, { type: "STOCK_OUT", quantity: cmd.quantity });
    } catch (err) {
      if (err instanceof DomainError) {
        commandsTotal.inc({ command_type: "STOCK_OUT", result: "rejected" });
        return res.status(422).json({ error: err.message });
      }
      throw err;
    }

    const payload = StockOutPayloadSchema.parse({
      event_type: "STOCK_OUT",
      productId: cmd.productId,
      warehouseId: cmd.warehouseId,
      locationId: cmd.locationId,
      quantity: cmd.quantity,
      performedBy: cmd.performedBy,
    });

    try {
      const appended = await appendEvents(
        cmd.aggregateId,
        [{ event_type: "STOCK_OUT", payload }],
        nextVersion,
      );
      try {
        for (const evt of appended) {
          await applyEventToReadModel(evt);
        }
      } catch (e) {
        console.error("[stock-service] projection failed for event:", e);
        throw e;
      }
      commandsTotal.inc({ command_type: "STOCK_OUT", result: "success" });
      console.log(
        `[stock-service] STOCK_OUT aggregate=${cmd.aggregateId} v=${appended[0].version}`,
      );
      return res.status(200).json({
        aggregateId: cmd.aggregateId,
        version: appended[0].version,
        event_type: "STOCK_OUT",
        payload,
      });
    } catch (err) {
      if (err instanceof ConflictError) {
        commandsTotal.inc({ command_type: "STOCK_OUT", result: "conflict" });
        return res.status(409).json({ error: err.message });
      }
      throw err;
    }
  }),
);

commandsRouter.post(
  "/adjustment",
  wrap(async (req, res) => {
    const parsed = AdjustmentCommandSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ errors: parsed.error.issues });
    }
    const cmd = parsed.data;

    const { state, nextVersion } = await loadAggregate(cmd.aggregateId);

    try {
      decide(state, {
        type: "ADJUSTMENT",
        reason_code: cmd.reason_code,
        quantity_delta: cmd.quantity_delta,
      });
    } catch (err) {
      if (err instanceof DomainError) {
        commandsTotal.inc({ command_type: "ADJUSTMENT", result: "rejected" });
        return res.status(422).json({ error: err.message });
      }
      throw err;
    }

    const payload = AdjustmentPayloadSchema.parse({
      event_type: "ADJUSTMENT",
      productId: cmd.productId,
      warehouseId: cmd.warehouseId,
      quantity_delta: cmd.quantity_delta,
      reason_code: cmd.reason_code,
      notes: cmd.notes,
      performedBy: cmd.performedBy,
    });

    try {
      const appended = await appendEvents(
        cmd.aggregateId,
        [{ event_type: "ADJUSTMENT", payload }],
        nextVersion,
      );
      try {
        for (const evt of appended) {
          await applyEventToReadModel(evt);
        }
      } catch (e) {
        console.error("[stock-service] projection failed for event:", e);
        throw e;
      }
      commandsTotal.inc({ command_type: "ADJUSTMENT", result: "success" });
      console.log(
        `[stock-service] ADJUSTMENT aggregate=${cmd.aggregateId} reason=${cmd.reason_code} v=${appended[0].version}`,
      );
      return res.status(200).json({
        aggregateId: cmd.aggregateId,
        version: appended[0].version,
        event_type: "ADJUSTMENT",
        payload,
      });
    } catch (err) {
      if (err instanceof ConflictError) {
        commandsTotal.inc({ command_type: "ADJUSTMENT", result: "conflict" });
        return res.status(409).json({ error: err.message });
      }
      throw err;
    }
  }),
);

// WH-02: POST /reserve - резервирует quantity. available -= quantity, on_hand без изменений
commandsRouter.post(
  "/reserve",
  wrap(async (req, res) => {
    const parsed = ReserveCommandSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ errors: parsed.error.issues });
    }
    const cmd = parsed.data;

    const { state, nextVersion } = await loadAggregate(cmd.aggregateId);

    try {
      decide(state, {
        type: "RESERVE",
        quantity: cmd.quantity,
        reservationId: cmd.reservationId,
      });
    } catch (err) {
      if (err instanceof DomainError) {
        commandsTotal.inc({ command_type: "RESERVE", result: "rejected" });
        return res.status(422).json({ error: err.message });
      }
      throw err;
    }

    const payload = ReservePayloadSchema.parse({
      event_type: "RESERVE",
      productId: cmd.productId,
      warehouseId: cmd.warehouseId,
      locationId: cmd.locationId,
      quantity: cmd.quantity,
      reservationId: cmd.reservationId,
      performedBy: cmd.performedBy,
    });

    try {
      const appended = await appendEvents(
        cmd.aggregateId,
        [{ event_type: "RESERVE", payload }],
        nextVersion,
      );
      try {
        for (const evt of appended) {
          await applyEventToReadModel(evt);
        }
      } catch (e) {
        console.error("[stock-service] projection failed for event:", e);
        throw e;
      }
      commandsTotal.inc({ command_type: "RESERVE", result: "success" });
      console.log(
        `[stock-service] RESERVE aggregate=${cmd.aggregateId} res=${cmd.reservationId} v=${appended[0].version}`,
      );
      return res.status(200).json({
        aggregateId: cmd.aggregateId,
        version: appended[0].version,
        event_type: "RESERVE",
        payload,
      });
    } catch (err) {
      if (err instanceof ConflictError) {
        commandsTotal.inc({ command_type: "RESERVE", result: "conflict" });
        return res.status(409).json({ error: err.message });
      }
      throw err;
    }
  }),
);

// POST /release - отменяет резервацию. reserved -= quantity
commandsRouter.post(
  "/release",
  wrap(async (req, res) => {
    const parsed = ReleaseCommandSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ errors: parsed.error.issues });
    }
    const cmd = parsed.data;

    const { state, nextVersion } = await loadAggregate(cmd.aggregateId);

    try {
      decide(state, {
        type: "RELEASE",
        quantity: cmd.quantity,
        reservationId: cmd.reservationId,
      });
    } catch (err) {
      if (err instanceof DomainError) {
        commandsTotal.inc({ command_type: "RELEASE", result: "rejected" });
        return res.status(422).json({ error: err.message });
      }
      throw err;
    }

    const payload = ReleasePayloadSchema.parse({
      event_type: "RELEASE",
      productId: cmd.productId,
      warehouseId: cmd.warehouseId,
      locationId: cmd.locationId,
      quantity: cmd.quantity,
      reservationId: cmd.reservationId,
      performedBy: cmd.performedBy,
    });

    try {
      const appended = await appendEvents(
        cmd.aggregateId,
        [{ event_type: "RELEASE", payload }],
        nextVersion,
      );
      try {
        for (const evt of appended) {
          await applyEventToReadModel(evt);
        }
      } catch (e) {
        console.error("[stock-service] projection failed for event:", e);
        throw e;
      }
      commandsTotal.inc({ command_type: "RELEASE", result: "success" });
      console.log(
        `[stock-service] RELEASE aggregate=${cmd.aggregateId} res=${cmd.reservationId} v=${appended[0].version}`,
      );
      return res.status(200).json({
        aggregateId: cmd.aggregateId,
        version: appended[0].version,
        event_type: "RELEASE",
        payload,
      });
    } catch (err) {
      if (err instanceof ConflictError) {
        commandsTotal.inc({ command_type: "RELEASE", result: "conflict" });
        return res.status(409).json({ error: err.message });
      }
      throw err;
    }
  }),
);

// POST /commit-reservation - товар уходит. on_hand -= quantity И reserved -= quantity
commandsRouter.post(
  "/commit-reservation",
  wrap(async (req, res) => {
    const parsed = CommitReservationCommandSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ errors: parsed.error.issues });
    }
    const cmd = parsed.data;

    const { state, nextVersion } = await loadAggregate(cmd.aggregateId);

    try {
      decide(state, {
        type: "COMMIT_RESERVATION",
        quantity: cmd.quantity,
        reservationId: cmd.reservationId,
      });
    } catch (err) {
      if (err instanceof DomainError) {
        commandsTotal.inc({
          command_type: "COMMIT_RESERVATION",
          result: "rejected",
        });
        return res.status(422).json({ error: err.message });
      }
      throw err;
    }

    const payload = CommitReservationPayloadSchema.parse({
      event_type: "COMMIT_RESERVATION",
      productId: cmd.productId,
      warehouseId: cmd.warehouseId,
      locationId: cmd.locationId,
      quantity: cmd.quantity,
      reservationId: cmd.reservationId,
      performedBy: cmd.performedBy,
    });

    try {
      const appended = await appendEvents(
        cmd.aggregateId,
        [{ event_type: "COMMIT_RESERVATION", payload }],
        nextVersion,
      );
      try {
        for (const evt of appended) {
          await applyEventToReadModel(evt);
        }
      } catch (e) {
        console.error("[stock-service] projection failed for event:", e);
        throw e;
      }
      commandsTotal.inc({
        command_type: "COMMIT_RESERVATION",
        result: "success",
      });
      console.log(
        `[stock-service] COMMIT_RESERVATION aggregate=${cmd.aggregateId} res=${cmd.reservationId} v=${appended[0].version}`,
      );
      return res.status(200).json({
        aggregateId: cmd.aggregateId,
        version: appended[0].version,
        event_type: "COMMIT_RESERVATION",
        payload,
      });
    } catch (err) {
      if (err instanceof ConflictError) {
        commandsTotal.inc({
          command_type: "COMMIT_RESERVATION",
          result: "conflict",
        });
        return res.status(409).json({ error: err.message });
      }
      throw err;
    }
  }),
);
