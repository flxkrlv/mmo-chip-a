import {
  createContext,
  useCallback,
  useContext,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";

/* ── Types ─────────────────────────────────────────────── */

interface ConfirmRequest {
  kind: "confirm";
  message: string;
  title?: string;
  resolve: (value: boolean) => void;
}

interface PromptRequest {
  kind: "prompt";
  message: string;
  defaultValue: string;
  title?: string;
  resolve: (value: string | null) => void;
}

type DialogRequest = ConfirmRequest | PromptRequest;

interface DialogAPI {
  confirm(message: string, title?: string): Promise<boolean>;
  prompt(
    message: string,
    defaultValue?: string,
    title?: string,
  ): Promise<string | null>;
}

/* ── Context ───────────────────────────────────────────── */

const DialogCtx = createContext<DialogAPI | null>(null);

/* ── Provider ──────────────────────────────────────────── */

export function DialogProvider({ children }: { children: React.ReactNode }) {
  const [request, setRequest] = useState<DialogRequest | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const confirm = useCallback(
    (message: string, title?: string) =>
      new Promise<boolean>((resolve) => {
        setRequest({ kind: "confirm", message, title, resolve });
      }),
    [],
  );

  const prompt = useCallback(
    (message: string, defaultValue = "", title?: string) =>
      new Promise<string | null>((resolve) => {
        setRequest({ kind: "prompt", message, defaultValue, title, resolve });
      }),
    [],
  );

  const handleConfirm = useCallback(() => {
    if (!request) return;
    if (request.kind === "confirm") {
      (request as ConfirmRequest).resolve(true);
    } else {
      (request as PromptRequest).resolve(inputRef.current?.value ?? request.defaultValue);
    }
    setRequest(null);
  }, [request]);

  const handleCancel = useCallback(() => {
    if (!request) return;
    if (request.kind === "confirm") {
      (request as ConfirmRequest).resolve(false);
    } else {
      (request as PromptRequest).resolve(null);
    }
    setRequest(null);
  }, [request]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter") {
        e.preventDefault();
        handleConfirm();
      } else if (e.key === "Escape") {
        e.preventDefault();
        handleCancel();
      }
    },
    [handleConfirm, handleCancel],
  );

  const api: DialogAPI = { confirm, prompt };

  return (
    <DialogCtx.Provider value={api}>
      {children}
      {request &&
        createPortal(
          <div
            className="dark dialog-overlay"
            onClick={handleCancel}
            onKeyDown={handleKeyDown}
          >
            <div
              className="popover dialog-box"
              onClick={(e) => e.stopPropagation()}
            >
              {request.title && (
                <div className="dialog-title">{request.title}</div>
              )}
              <div className="dialog-message">{request.message}</div>
              {request.kind === "prompt" && (
                <input
                  ref={inputRef}
                  className="dialog-input"
                  type="text"
                  defaultValue={request.defaultValue}
                  autoFocus
                  onKeyDown={handleKeyDown}
                />
              )}
              <div className="dialog-actions">
                <button className="btn" onClick={handleCancel}>
                  Cancel
                </button>
                <button
                  className="btn accent"
                  onClick={handleConfirm}
                  ref={(el) => {
                    if (request.kind === "confirm") el?.focus();
                  }}
                >
                  OK
                </button>
              </div>
            </div>
          </div>,
          document.body,
        )}
    </DialogCtx.Provider>
  );
}

/* ── Hook ──────────────────────────────────────────────── */

export function useDialog(): DialogAPI {
  const ctx = useContext(DialogCtx);
  if (!ctx) throw new Error("useDialog must be used within DialogProvider");
  return ctx;
}
