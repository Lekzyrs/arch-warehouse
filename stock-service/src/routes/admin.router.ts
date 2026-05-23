import {
  Router,
  type NextFunction,
  type Request,
  type Response,
} from "express";
import { rebuildReadModels } from "../read/projector";

// T-04-12: destructive admin endpoint. X-Admin-Key header сверяется с process.env.ADMIN_KEY.
// без ADMIN_KEY -> 503 (misconfigured). неверный/отсутствующий header -> 403.

export const adminRouter = Router();

function wrap(
  fn: (req: Request, res: Response) => Promise<unknown>,
): (req: Request, res: Response, next: NextFunction) => void {
  return (req, res, next) => {
    fn(req, res).catch(next);
  };
}

function checkAdminKey(req: Request, res: Response): boolean {
  const ADMIN_KEY = process.env.ADMIN_KEY;
  if (!ADMIN_KEY) {
    res.status(503).json({
      error: "Admin key not configured - set ADMIN_KEY env var",
    });
    return false;
  }
  if (req.headers["x-admin-key"] !== ADMIN_KEY) {
    console.log(
      "[stock-service] admin/replay rejected: wrong or missing X-Admin-Key",
    );
    res.status(403).json({ error: "Forbidden" });
    return false;
  }
  return true;
}

// CQRS-05/06: TRUNCATE + replay из events table в детерминированном порядке.
adminRouter.post(
  "/replay",
  wrap(async (req, res) => {
    if (!checkAdminKey(req, res)) return;
    console.log("[stock-service] POST /admin/replay triggered");
    try {
      await rebuildReadModels();
      return res.status(200).json({
        ok: true,
        message: "Read model rebuilt from event log",
      });
    } catch (e) {
      console.error("[stock-service] replay failed:", e);
      return res
        .status(500)
        .json({ error: `Replay failed: ${(e as Error).message}` });
    }
  }),
);
