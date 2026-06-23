import { apiPost } from "./client";

interface AuthResponse {
  token: string;
  userId: string;
  username: string;
}

interface VerifyResponse {
  userId: string;
  username: string;
}

export async function register(username: string, password: string): Promise<AuthResponse> {
  return apiPost<AuthResponse>("/api/auth/register", { username, password });
}

export async function login(username: string, password: string): Promise<AuthResponse> {
  return apiPost<AuthResponse>("/api/auth/login", { username, password });
}

export async function verify(token: string): Promise<VerifyResponse> {
  return apiPost<VerifyResponse>("/api/auth/verify", { token });
}

interface AuthStatusResponse {
  authEnabled: boolean;
  authenticated: boolean;
  userId: string | null;
  username: string | null;
}

/** Check whether auth is enabled on the server. Always succeeds (no auth required). */
export async function checkAuthStatus(): Promise<AuthStatusResponse> {
  const res = await fetch("/api/auth/status");
  if (!res.ok) {
    return { authEnabled: true, authenticated: false, userId: null, username: null };
  }
  return res.json();
}
