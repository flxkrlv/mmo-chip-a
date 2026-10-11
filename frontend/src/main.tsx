import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { QueryClientProvider } from "@tanstack/react-query";
import App from "./App";
import { queryClient } from "./lib/queryClient";
import { loadClipper } from "./lib/extraction";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { installWheelZoomGuard } from "./lib/zoomGuard";
import { usePreferences } from "./state/preferences";
import { ToastProvider } from "./components/Toast";
import { DialogProvider } from "./components/Dialog";
import "./styles/tokens.css";
import "./styles/global.css";

// Load Clipper2 WASM as early as possible — cached singleton, idempotent.
// Required by splitDiffusionAtGates() for multi-finger MOS diffusion cutting.
loadClipper().catch(() => {});

// Браузерный зум Ctrl/Cmd + wheel и pinch: по умолчанию отключён, включается в Settings
// (browserWheelZoomEnabled). Ctrl/Cmd + "+"/"-" не трогаем.
installWheelZoomGuard(window, {
  isAllowed: () => usePreferences.getState().browserWheelZoomEnabled,
});

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <DialogProvider>
        <ToastProvider>
          <BrowserRouter>
            <ErrorBoundary>
              <App />
            </ErrorBoundary>
          </BrowserRouter>
        </ToastProvider>
      </DialogProvider>
    </QueryClientProvider>
  </React.StrictMode>
);
