import { create } from "zustand";
import { persist } from "zustand/middleware";

const AUTH_STORE_KEY = "mmo-chip-auth";

interface AuthState {
  token: string | null;
  userId: string | null;
  username: string | null;
}

interface AuthActions {
  setAuth: (token: string, userId: string, username: string) => void;
  clearAuth: () => void;
  isAuthenticated: () => boolean;
}

export const useAuth = create<AuthState & AuthActions>()(
  persist(
    (set, get) => ({
      token: null,
      userId: null,
      username: null,

      setAuth(token: string, userId: string, username: string) {
        set({ token, userId, username });
      },

      clearAuth() {
        set({ token: null, userId: null, username: null });
      },

      isAuthenticated() {
        return get().token !== null;
      }
    }),
    {
      name: AUTH_STORE_KEY,
      version: 1
    }
  )
);

/** Convenience: read auth token for API calls. */
export function getAuthToken(): string | null {
  return useAuth.getState().token;
}
