import type { Server as HttpServer } from "node:http";
import type { MLInferenceJob } from "shared";
import { WebSocketServer, type WebSocket } from "ws";

/**
 * Realtime change broadcaster.
 *
 * Protocol:
 *   client → server :  { "type": "subscribe",   "dieId": "<id>" }
 *                      { "type": "unsubscribe", "dieId": "<id>" }
 *   server → client :  { "type": "annotations", "dieId": "<id>", "rev": <number> }
 *                      { "type": "mlJob", "dieId": "<id>", "job": <MLInferenceJob> }
 *                      { "type": "pong" }    (response to {"type":"ping"})
 *
 * Annotation changes carry no payload — clients invalidate and refetch. ML
 * job updates carry the whole (small) job record so every connected client
 * sees inference progress live, including jobs another user triggered.
 */

type ServerMessage =
  | { type: "annotations"; dieId: string; rev: number }
  | { type: "mlJob"; dieId: string; job: MLInferenceJob }
  | { type: "pong" };

type ClientMessage =
  | { type: "subscribe"; dieId: string }
  | { type: "unsubscribe"; dieId: string }
  | { type: "ping" };

interface Subscription {
  socket: WebSocket;
  dies: Set<string>;
}

export interface AnnotationBroadcaster {
  /** Notify subscribed clients that a die's annotations advanced to `rev`. */
  emitAnnotationChange(dieId: string, rev: number): void;
  /** Push an ML inference job-state change to subscribed clients. */
  emitMLJob(job: MLInferenceJob): void;
  /** Close the server. */
  close(): Promise<void>;
}

export function attachWebSocketBroadcaster(httpServer: HttpServer): AnnotationBroadcaster {
  const wss = new WebSocketServer({ server: httpServer, path: "/api/ws" });
  const subscriptions = new Map<WebSocket, Subscription>();

  wss.on("connection", (socket) => {
    const sub: Subscription = { socket, dies: new Set() };
    subscriptions.set(socket, sub);

    socket.on("message", (raw) => {
      let msg: ClientMessage;
      try {
        msg = JSON.parse(raw.toString()) as ClientMessage;
      } catch {
        return; // ignore malformed
      }
      switch (msg.type) {
        case "subscribe":
          if (typeof msg.dieId === "string") sub.dies.add(msg.dieId);
          return;
        case "unsubscribe":
          if (typeof msg.dieId === "string") sub.dies.delete(msg.dieId);
          return;
        case "ping":
          send(socket, { type: "pong" });
          return;
      }
    });

    socket.on("close", () => {
      subscriptions.delete(socket);
    });
    socket.on("error", () => {
      subscriptions.delete(socket);
    });
  });

  function send(socket: WebSocket, msg: ServerMessage) {
    if (socket.readyState !== socket.OPEN) return;
    try {
      socket.send(JSON.stringify(msg));
    } catch {
      // ignore — closed sockets are cleaned up by the close/error handlers
    }
  }

  return {
    emitAnnotationChange(dieId, rev) {
      for (const sub of subscriptions.values()) {
        if (!sub.dies.has(dieId)) continue;
        send(sub.socket, { type: "annotations", dieId, rev });
      }
    },
    emitMLJob(job) {
      for (const sub of subscriptions.values()) {
        if (!sub.dies.has(job.dieId)) continue;
        send(sub.socket, { type: "mlJob", dieId: job.dieId, job });
      }
    },
    async close() {
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    }
  };
}
