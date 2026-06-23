import cors from "cors";
import express from "express";
import { createImportJobManager } from "./dieImport/jobs.js";
import { createAnnotationsRouter } from "./api/annotations.js";
import { createDiesRouter } from "./api/dies.js";
import { createHealthRouter } from "./api/health.js";
import { createJobsRouter } from "./api/jobs.js";
import { createMLRouter } from "./api/ml.js";
import { createOverlayImagesRouter } from "./api/overlayImages.js";
import { createMLExportRouter } from "./api/mlExport.js";
import { createAnalogExportRouter } from "./api/analogExport.js";
import { createAuthRouter } from "./api/auth.js";
import { createProjectIORouter } from "./api/projectIO.js";
import { createTilesRouter } from "./api/tiles.js";
import { listDieRecords } from "./store.js";
import { createTileScheduler } from "./tileScheduler.js";
import type { AnnotationBroadcaster } from "./ws.js";
import { requireAuth, isAuthEnabled } from "./auth/middleware.js";

export function createApp(config: {
  dataRoot: string;
  tileSize: number;
  limitInputPixels: number | false;
  tileConcurrency: number;
  mlSidecarUrl: string;
  mlPredictPad: number;
  broadcaster?: AnnotationBroadcaster;
}) {
  const app = express();
  const tileScheduler = createTileScheduler({
    dataRoot: config.dataRoot,
    concurrency: config.tileConcurrency
  });
  const importJobManager = createImportJobManager({
    ...config,
    tileScheduler
  });

  void listDieRecords(config.dataRoot)
    .then((records) => {
      for (const record of records) {
        tileScheduler.enqueueBackground(record);
      }
    })
    .catch((error) => {
      console.error("Failed to resume background tile generation", error);
    });

  app.use(cors() as unknown as express.RequestHandler);
  app.use(express.json({ limit: "50mb" }));

  // Auth middleware (applied to all /api/* except public paths)
  app.use("/api", (request, response, next) => {
    const path = request.path;
    const method = request.method;
    // Public GET paths — loaded via <img> tags that can't carry auth headers
    if (method === "GET") {
      if (
        path.startsWith("/auth/") ||
        path.startsWith("/health/") ||
        path.startsWith("/dies/") // tile images, original image, overlays loaded via <img>
      ) {
        return next();
      }
    } else {
      // Non-GET: only auth and health are public
      if (path.startsWith("/auth/") || path.startsWith("/health/")) {
        return next();
      }
    }
    return requireAuth(request, response, next);
  });

  // Public routes
  app.use(createHealthRouter());
  app.use(createAuthRouter({ dataRoot: config.dataRoot }));

  // Protected routes
  app.use(createJobsRouter({ dataRoot: config.dataRoot }));
  app.use(
    createDiesRouter({
      dataRoot: config.dataRoot,
      tileScheduler,
      importJobManager
    })
  );
  app.use(createTilesRouter({ dataRoot: config.dataRoot, tileScheduler }));
  app.use(
    createAnnotationsRouter({
      dataRoot: config.dataRoot,
      onAnnotationsChanged: (dieId, rev) =>
        config.broadcaster?.emitAnnotationChange(dieId, rev)
    })
  );
  app.use(createMLExportRouter({ dataRoot: config.dataRoot }));
  app.use(createAnalogExportRouter({ dataRoot: config.dataRoot }));
  app.use(createOverlayImagesRouter({ dataRoot: config.dataRoot }));
  app.use(createMLRouter({
    mlSidecarUrl: config.mlSidecarUrl,
    dataRoot: config.dataRoot,
    mlPredictPad: config.mlPredictPad,
    broadcaster: config.broadcaster
  }));
  app.use(createProjectIORouter({ dataRoot: config.dataRoot }));

  app.use(
    (
      error: unknown,
      _request: express.Request,
      response: express.Response,
      _next: express.NextFunction
    ) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        response.status(404).json({ error: "Not found" });
        return;
      }

      response.status(500).json({
        error: error instanceof Error ? error.message : "Unknown server error"
      });
    }
  );

  return app;
}
