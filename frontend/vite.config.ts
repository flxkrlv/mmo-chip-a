import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      comlink: path.resolve(
        __dirname,
        "../node_modules/comlink/dist/esm/comlink.js"
      ),
    },
  },
  server: {
    port: 5173,
    host: "0.0.0.0",
    proxy: {
      "/api/ws": {
        target: "ws://localhost:3001",
        ws: true,
        rewriteWsOrigin: true,
      },
      "/api": {
        target: "http://localhost:3001",
        timeout: 600000,
        proxyTimeout: 600000,
      },
    },
  },
}); 