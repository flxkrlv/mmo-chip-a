// Bump libuv thread pool before any module imports sharp/fs. Static ESM imports
// run before module-level code, so we use dynamic imports below to ensure this
// env var is in place before sharp's native binding initializes.
if (!process.env.UV_THREADPOOL_SIZE) {
  process.env.UV_THREADPOOL_SIZE = "16";
}

async function main() {
  const { createApp } = await import("./app.js");
  const { config } = await import("./config.js");
  const { ensureDataStore } = await import("./store.js");
  const { attachWebSocketBroadcaster } = await import("./ws.js");
  const { verifyToken, isAuthEnabled } = await import("./auth/middleware.js");
  const { createServer } = await import("node:http");

  await ensureDataStore(config.dataRoot);
  const httpServer = createServer();
  const authEnabled = isAuthEnabled();
  const broadcaster = attachWebSocketBroadcaster(httpServer, verifyToken, authEnabled);
  const app = createApp({ ...config, broadcaster });
  httpServer.on("request", app);
  httpServer.listen(config.port, () => {
    console.log(`chiptool backend listening on http://localhost:${config.port}`);
  });
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
