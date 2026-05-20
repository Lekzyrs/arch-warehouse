import {
  Router,
  type NextFunction,
  type Request,
  type Response,
} from "express";
import { getBalance, listBalances } from "../read/readModels";

// CQRS-02: query path импортирует только из ../read/readModels.
// запрещены: eventStore, stockAggregate, eventSchemas, errors - проверяется grep в acceptance.

export const queryRouter = Router();

function wrap(
  fn: (req: Request, res: Response) => Promise<unknown>,
): (req: Request, res: Response, next: NextFunction) => void {
  return (req, res, next) => {
    fn(req, res).catch(next);
  };
}

// GET /stock?productId=&warehouseId=&locationId=
// возвращает массив всех совпадений (CQRS-03 read-your-writes)
queryRouter.get(
  "/",
  wrap(async (req, res) => {
    try {
      const productId =
        typeof req.query.productId === "string" ? req.query.productId : null;
      const warehouseId =
        typeof req.query.warehouseId === "string"
          ? req.query.warehouseId
          : null;
      const rows = await listBalances({ productId, warehouseId });
      return res.status(200).json(rows);
    } catch (e) {
      console.error("[stock-service] query error:", e);
      return res.status(500).json({ error: "Internal server error" });
    }
  }),
);

// GET /stock/:productId/:warehouseId?locationId=
// 200 + row или 404 если row не существует
queryRouter.get(
  "/:productId/:warehouseId",
  wrap(async (req, res) => {
    try {
      const { productId, warehouseId } = req.params;
      const locationId =
        typeof req.query.locationId === "string" ? req.query.locationId : "";
      const row = await getBalance(productId, warehouseId, locationId);
      if (row === null) {
        return res.status(404).json({
          error: `Stock balance not found for product=${productId} warehouse=${warehouseId}`,
        });
      }
      return res.status(200).json(row);
    } catch (e) {
      console.error("[stock-service] query error:", e);
      return res.status(500).json({ error: "Internal server error" });
    }
  }),
);
