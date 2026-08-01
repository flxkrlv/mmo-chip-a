import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";

type ToastType = "success" | "error" | "warning";

interface ToastItem {
  id: number;
  type: ToastType;
  message: string;
  detail?: string;
}

interface ToastAPI {
  success(message: string, detail?: string): void;
  error(message: string, detail?: string): void;
  warning(message: string, detail?: string): void;
}

const ToastCtx = createContext<ToastAPI | null>(null);

let nextId = 0;

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const timers = useRef<Map<number, ReturnType<typeof setTimeout>>>(new Map());

  const dismiss = useCallback((id: number) => {
    const t = timers.current.get(id);
    if (t) {
      clearTimeout(t);
      timers.current.delete(id);
    }
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const push = useCallback(
    (type: ToastType, message: string, detail?: string) => {
      const id = ++nextId;
      setToasts((prev) => [...prev, { id, type, message, detail }]);
      const timer = setTimeout(() => dismiss(id), 5000);
      timers.current.set(id, timer);
    },
    [dismiss],
  );

  const api = useMemo<ToastAPI>(
    () => ({
      success: (msg, detail) => push("success", msg, detail),
      error: (msg, detail) => push("error", msg, detail),
      warning: (msg, detail) => push("warning", msg, detail),
    }),
    [push],
  );

  return (
    <ToastCtx.Provider value={api}>
      {children}
      {createPortal(
        <div className="dark toast-container">
          {toasts.map((t) => (
            <div key={t.id} className={`toast ${t.type}`}>
              <span className="toast-msg">{t.message}</span>
              {t.detail && <span className="toast-detail">{t.detail}</span>}
              <button
                className="toast-close"
                onClick={() => dismiss(t.id)}
                aria-label="Dismiss"
              >
                ×
              </button>
            </div>
          ))}
        </div>,
        document.body,
      )}
    </ToastCtx.Provider>
  );
}

export function useToast(): ToastAPI {
  const ctx = useContext(ToastCtx);
  if (!ctx) throw new Error("useToast must be used within ToastProvider");
  return ctx;
}
