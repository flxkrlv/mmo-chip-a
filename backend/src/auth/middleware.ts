import type { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import type { AuthPayload } from "../types.js";

export { getJwtSecret, signToken, verifyToken, requireAuth, optionalAuth, extractWsToken, extractAuthFromRequest, isAuthEnabled };

let jwtSecret: string | null = null;

function getJwtSecret(): string | null {
  if (jwtSecret !== null) return jwtSecret;
  const env = process.env.JWT_SECRET;
  if (env && env.length > 0) {
    jwtSecret = env;
    return jwtSecret;
  }
  // No JWT_SECRET → auth is disabled (dev/test mode)
  jwtSecret = null;
  return null;
}

/** Is auth enabled? False when JWT_SECRET is not set (dev/test mode). */
function isAuthEnabled(): boolean {
  return getJwtSecret() !== null;
}

function signToken(payload: AuthPayload): string {
  const secret = getJwtSecret();
  if (!secret) throw new Error("Auth disabled: JWT_SECRET not set");
  return jwt.sign(payload, secret, { expiresIn: "7d" });
}

function verifyToken(token: string): AuthPayload | null {
  const secret = getJwtSecret();
  if (!secret) return null;
  try {
    return jwt.verify(token, secret) as AuthPayload;
  } catch {
    return null;
  }
}

// Express middleware: rejects if no valid token
function requireAuth(request: Request, response: Response, next: NextFunction): void {
  if (!isAuthEnabled()) {
    // Auth disabled (dev/test mode) — skip check
    (request as any).user = { userId: "dev", username: "dev" };
    return next();
  }
  const payload = extractAuthFromRequest(request);
  if (!payload) {
    response.status(401).json({ error: "Authentication required" });
    return;
  }
  (request as any).user = payload;
  next();
}

// Express middleware: sets req.user if token present, continues anyway
function optionalAuth(request: Request, _response: Response, next: NextFunction): void {
  if (!isAuthEnabled()) {
    (request as any).user = { userId: "dev", username: "dev" };
    return next();
  }
  const payload = extractAuthFromRequest(request);
  if (payload) {
    (request as any).user = payload;
  }
  next();
}

function extractAuthFromRequest(request: Request): AuthPayload | null {
  const header = request.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) return null;
  const token = header.slice(7);
  return verifyToken(token);
}

function extractWsToken(url: string | undefined): AuthPayload | null {
  if (!url) return null;
  try {
    const parsed = new URL(url, "http://localhost");
    const token = parsed.searchParams.get("token");
    if (!token) return null;
    return verifyToken(token);
  } catch {
    return null;
  }
}
