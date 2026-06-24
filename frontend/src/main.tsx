import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { QueryClientProvider } from "@tanstack/react-query";
import App from "./App";
import { queryClient } from "./lib/queryClient";
import { loadClipper } from "./lib/extraction";
import "./styles/tokens.css";
import "./styles/global.css";

// Load Clipper2 WASM as early as possible — cached singleton, idempotent.
// Required by splitDiffusionAtGates() for multi-finger MOS diffusion cutting.
loadClipper().catch(() => {});

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </QueryClientProvider>
  </React.StrictMode>
);
