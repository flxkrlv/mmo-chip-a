import { Router } from "express";
import bcrypt from "bcryptjs";
import { createUser, findUserByUsername, findUserById } from "../store.js";
import { signToken, verifyToken, extractAuthFromRequest, isAuthEnabled } from "../auth/middleware.js";

const SALT_ROUNDS = 10;

export function createAuthRouter(config: { dataRoot: string }) {
  const router = Router();

  // POST /api/auth/register
  router.post("/api/auth/register", async (request, response, next) => {
    try {
      const { username, password } = request.body as { username?: string; password?: string };

      if (!username || typeof username !== "string" || username.trim().length < 2) {
        response.status(400).json({ error: "Username must be at least 2 characters" });
        return;
      }
      if (!password || typeof password !== "string" || password.length < 4) {
        response.status(400).json({ error: "Password must be at least 4 characters" });
        return;
      }

      const normalized = username.trim().toLowerCase();
      const existing = await findUserByUsername(config.dataRoot, normalized);
      if (existing) {
        response.status(409).json({ error: "Username already taken" });
        return;
      }

      const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
      const user = {
        id: genUuid(),
        username: normalized,
        passwordHash,
        createdAt: new Date().toISOString()
      };
      await createUser(config.dataRoot, user);

      const token = signToken({ userId: user.id, username: user.username });
      response.status(201).json({ token, userId: user.id, username: user.username });
    } catch (error) {
      next(error);
    }
  });

  // POST /api/auth/login
  router.post("/api/auth/login", async (request, response, next) => {
    try {
      const { username, password } = request.body as { username?: string; password?: string };

      if (!username || typeof username !== "string" || !password || typeof password !== "string") {
        response.status(400).json({ error: "Username and password required" });
        return;
      }

      const normalized = username.trim().toLowerCase();
      const user = await findUserByUsername(config.dataRoot, normalized);
      if (!user) {
        response.status(401).json({ error: "Invalid username or password" });
        return;
      }

      const valid = await bcrypt.compare(password, user.passwordHash);
      if (!valid) {
        response.status(401).json({ error: "Invalid username or password" });
        return;
      }

      const token = signToken({ userId: user.id, username: user.username });
      response.json({ token, userId: user.id, username: user.username });
    } catch (error) {
      next(error);
    }
  });

  // GET /api/auth/status — check if auth is enabled and if the current token is valid
  router.get("/api/auth/status", (request, response) => {
    const payload = extractAuthFromRequest(request);
    response.json({
      authEnabled: isAuthEnabled(),
      authenticated: payload !== null,
      userId: payload?.userId ?? null,
      username: payload?.username ?? null
    });
  });

  // POST /api/auth/verify
  router.post("/api/auth/verify", async (request, response, next) => {
    try {
      const { token } = request.body as { token?: string };
      if (!token || typeof token !== "string") {
        response.status(400).json({ error: "Token required" });
        return;
      }

      const payload = verifyToken(token);
      if (!payload) {
        response.status(401).json({ error: "Invalid or expired token" });
        return;
      }

      // Verify user still exists
      const user = await findUserById(config.dataRoot, payload.userId);
      if (!user) {
        response.status(401).json({ error: "User not found" });
        return;
      }

      response.json({ userId: user.id, username: user.username });
    } catch (error) {
      next(error);
    }
  });

  return router;
}

function genUuid(): string {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });
}
