import {
  Router,
  type NextFunction,
  type Request,
  type Response,
} from "express";
import { Counter } from "prom-client";
import { z } from "zod";
import { ConflictError, DomainError } from "../domain/errors";
import { StockInPayloadSchema } from "../domain/eventSchemas";
import {
  appendEvents,
  decide,
  loadAggregate,
} from "../domain/stockAggregate";
import { registry } from "../metrics/registry";

// command DTO. aggregateId = одна aggregate-stream на пару product+warehouse
const StockInCommandSchema = z.object({
  aggregateId: z.string().min(1),
  productId: z.string().min(1),
  warehouseId: z.string().min(1),
  locationId: z.string().optional(),
  quantity: z.number().int().positive(),
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
