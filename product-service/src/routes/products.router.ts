import { Router, type Request, type Response, type NextFunction } from "express";
import {
  CreateProductDtoSchema,
  UpdateProductDtoSchema,
} from "../schemas/product.schema";
import * as repo from "../repositories/product.repo";

export const productsRouter = Router();

// единая обёртка для async-хендлеров. без неё ошибка из await потеряется
function wrap(
  fn: (req: Request, res: Response) => Promise<unknown>,
): (req: Request, res: Response, next: NextFunction) => void {
  return (req, res, next) => {
    fn(req, res).catch(next);
  };
}

productsRouter.post(
  "/",
  wrap(async (req, res) => {
    const parsed = CreateProductDtoSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ errors: parsed.error.issues });
    }
    const product = await repo.create(parsed.data);
    return res.status(201).json(product);
  }),
);

productsRouter.get(
  "/",
  wrap(async (_req, res) => {
    const products = await repo.findAll();
    return res.json(products);
  }),
);

productsRouter.get(
  "/:id",
  wrap(async (req, res) => {
    const product = await repo.findById(req.params.id);
    if (!product) return res.status(404).json({ error: "Not found" });
    return res.json(product);
  }),
);

productsRouter.put(
  "/:id",
  wrap(async (req, res) => {
    const parsed = UpdateProductDtoSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ errors: parsed.error.issues });
    }
    const product = await repo.update(req.params.id, parsed.data);
    if (!product) return res.status(404).json({ error: "Not found" });
    return res.json(product);
  }),
);

productsRouter.delete(
  "/:id",
  wrap(async (req, res) => {
    const removed = await repo.remove(req.params.id);
    if (!removed) return res.status(404).json({ error: "Not found" });
    return res.sendStatus(204);
  }),
);
