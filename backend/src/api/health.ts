import { Router } from "express";

export function createHealthRouter() {
  const router = Router();

  router.get("/api/health", (_request, response) => {
    response.json({ ok: true });
  });

  return router;
}
