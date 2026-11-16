import { createReadStream, statSync } from "node:fs";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { extname, resolve, sep } from "node:path";
import { pipeline } from "node:stream";
import { MatchLogManager } from "./match-logger.ts";
import { MatchManager } from "./match.ts";
import { logger } from "./logging.ts";
import { ServerMetrics } from "./metrics.ts";
import { RoomManager } from "./room-manager.ts";
import { attachWebSocketServer } from "./websocket-server.ts";
import type { ServerConfig } from "./config.ts";
import type { MatchLogEvent } from "./match-logger.ts";

const MIME_TYPES = new Map([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".ico", "image/x-icon"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
  [".webmanifest", "application/manifest+json; charset=utf-8"],
  [".wav", "audio/wav"],
]);
const MAX_BODY_BYTES = 8 * 1024;

function sendJson(
  response: ServerResponse,
  statusCode: number,
  value: unknown,
): void {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  response.end(JSON.stringify(value));
}

class HttpStatusError extends Error {
  statusCode: number;

  constructor(message: string, statusCode: number) {
    super(message);
    this.statusCode = statusCode;
  }
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > MAX_BODY_BYTES)
      throw new HttpStatusError("Request body is too large", 413);
    chunks.push(bytes);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpStatusError("Request body must be valid JSON", 400);
  }
}

function resolveStaticPath(
  staticDirectory: string,
  pathname: string,
): string | null {
  let decodedPath;
  try {
    decodedPath = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (decodedPath.includes("\\") || decodedPath.split("/").includes(".."))
    return null;

  const relativePath =
    decodedPath === "/" ? "index.html" : decodedPath.slice(1);
  const absolutePath = resolve(staticDirectory, relativePath);
  if (!absolutePath.startsWith(`${resolve(staticDirectory)}${sep}`))
    return null;
  return absolutePath;
}

async function serveStatic(
  request: IncomingMessage,
  response: ServerResponse,
  staticDirectory: string,
  pathname: string,
  logger: typeof import("./logging.ts").logger,
): Promise<void> {
  const filePath = resolveStaticPath(staticDirectory, pathname);
  if (!filePath) {
    sendJson(response, 400, { error: "Invalid path" });
    return;
  }

  let info;
  try {
    info = statSync(filePath);
    if (!info.isFile()) throw new Error("Not a file");
  } catch {
    sendJson(response, 404, { error: "Not found" });
    return;
  }

  response.writeHead(200, {
    "Content-Type":
      MIME_TYPES.get(extname(filePath)) ?? "application/octet-stream",
    "Content-Length": info.size,
    "X-Content-Type-Options": "nosniff",
  });
  if (request.method === "HEAD") {
    response.end();
    return;
  }
  pipeline(createReadStream(filePath), response, (error) => {
    if (error && !response.destroyed) {
      logger.error({ err: error, filePath }, "Static file stream failed");
      response.destroy(error);
    }
  });
}

function testEndpoint(
  request: IncomingMessage,
  response: ServerResponse,
  pathname: string,
): boolean {
  if (pathname === "/api/test/offline") {
    request.socket.destroy();
    return true;
  }
  if (pathname === "/api/test/corrupt-json") {
    response.writeHead(200, {
      "Content-Type": "application/json; charset=utf-8",
    });
    response.end('{"rooms": [');
    return true;
  }
  if (pathname === "/api/test/missing-sprite.svg") {
    sendJson(response, 404, { error: "Test sprite not found" });
    return true;
  }
  if (
    pathname === "/api/test/timeout" ||
    pathname === "/api/test/slow-sprite.svg"
  ) {
    const timer = setTimeout(() => {
      if (response.destroyed) return;
      if (pathname.endsWith(".svg")) {
        response.writeHead(200, { "Content-Type": "image/svg+xml" });
        response.end(
          '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"/>',
        );
      } else {
        sendJson(response, 200, { ok: true });
      }
    }, 1800);
    response.on("close", () => clearTimeout(timer));
    return true;
  }
  return false;
}

export async function createApplication(config: ServerConfig) {
  const metrics = new ServerMetrics();
  const roomManager = await new RoomManager({
    maxRooms: config.maxRooms ?? 100,
    maxPlayers: config.maxPlayers ?? 400,
    logger,
    metrics,
  }).load(config.roomDefinitions);
  const matchManager = new MatchManager(roomManager);
  const logs = new MatchLogManager(config.logDirectory);
  const activeLogs = new Map<
    string,
    Promise<import("./match-logger.ts").MatchLogger>
  >();
  roomManager.on("room-removed", (room) => activeLogs.delete(room.id));

  async function getMatchLogger(
    roomId: string,
  ): Promise<import("./match-logger.ts").MatchLogger> {
    if (!activeLogs.has(roomId)) {
      activeLogs.set(
        roomId,
        logs.open(roomId).then((matchLogger) => {
          for (const eventName of ["join", "leave", "chat", "slow-client"]) {
            const handler = (event: MatchLogEvent) => {
              void matchLogger
                .append({ ...event, type: eventName })
                .catch((error: unknown) =>
                  logger.error(
                    { err: error, roomId },
                    "Failed to write match log event",
                  ),
                );
            };
            roomManager.get(roomId)?.on(eventName, handler);
          }
          return matchLogger;
        }),
      );
    }
    const activeLog = activeLogs.get(roomId);
    if (!activeLog) throw new Error("Unable to initialize match log");
    return activeLog;
  }

  let acceptingConnections = true;
  const server = createServer((request, response) => {
    void handleRequest(request, response).catch((error: unknown) => {
      logger.error({ err: error }, "HTTP request handler failed");
      if (response.headersSent)
        response.destroy(error instanceof Error ? error : undefined);
      else sendJson(response, 500, { error: "Internal server error" });
    });
  });

  async function handleRequest(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    let rawPath;
    try {
      rawPath = decodeURIComponent((request.url ?? "/").split("?")[0] ?? "/");
    } catch {
      sendJson(response, 400, { error: "Invalid request path" });
      return;
    }
    if (rawPath.includes("\\") || rawPath.split("/").includes("..")) {
      sendJson(response, 400, { error: "Invalid request path" });
      return;
    }

    let url;
    try {
      url = new URL(request.url ?? "/", "http://localhost");
    } catch {
      sendJson(response, 400, { error: "Invalid request URL" });
      return;
    }

    if (url.pathname === "/health" && request.method === "GET") {
      sendJson(response, 200, {
        status: "ok",
        buildSha: config.buildSha ?? "dev",
      });
      return;
    }
    if (url.pathname === "/ready" && request.method === "GET") {
      const ready = acceptingConnections && roomManager.canAcceptPlayer;
      sendJson(response, ready ? 200 : 503, {
        status: ready ? "ready" : "not-ready",
      });
      return;
    }
    if (url.pathname === "/metrics" && request.method === "GET") {
      const stats = matchManager.stats();
      sendJson(
        response,
        200,
        metrics.snapshot({
          rooms: roomManager.list().length,
          activePlayers: stats.activePlayers,
          averageStepMs: stats.averageTickDurationMs,
        }),
      );
      return;
    }
    if (url.pathname.startsWith("/api/test/") && request.method === "GET") {
      if (testEndpoint(request, response, url.pathname)) return;
    }
    if (url.pathname === "/api/matches/stats" && request.method === "GET") {
      sendJson(response, 200, matchManager.stats());
      return;
    }
    if (url.pathname === "/api/rooms") {
      if (request.method === "GET") {
        sendJson(response, 200, { rooms: roomManager.list() });
        return;
      }
      if (request.method === "POST") {
        try {
          const body = await readJsonBody(request);
          const room = roomManager.create(body);
          sendJson(response, 201, { room: room.summary });
        } catch (error) {
          sendJson(
            response,
            error instanceof HttpStatusError ? error.statusCode : 400,
            { error: error instanceof Error ? error.message : "Invalid room" },
          );
        }
        return;
      }
      sendJson(response, 405, { error: "Method not allowed" });
      return;
    }
    const replayMatch = url.pathname.match(
      /^\/api\/matches\/([a-z0-9-]+)\/replay$/,
    );
    if (replayMatch && request.method === "GET") {
      const matchId = replayMatch[1];
      if (!matchId) {
        sendJson(response, 400, { error: "Invalid match id" });
        return;
      }
      const filePath = resolve(config.logDirectory, `${matchId}.ndjson`);
      if (!filePath.startsWith(`${resolve(config.logDirectory)}${sep}`)) {
        sendJson(response, 400, { error: "Invalid match id" });
        return;
      }
      try {
        statSync(filePath);
      } catch (error) {
        if (
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          error.code === "ENOENT"
        )
          sendJson(response, 404, { error: "Match log not found" });
        else sendJson(response, 500, { error: "Unable to open match log" });
        return;
      }
      response.writeHead(200, {
        "Content-Type": "application/x-ndjson; charset=utf-8",
      });
      pipeline(createReadStream(filePath), response, (error) => {
        if (error && !response.destroyed) {
          logger.error({ err: error, matchId }, "Match replay stream failed");
          response.destroy(error);
        }
      });
      return;
    }

    if (request.method !== "GET" && request.method !== "HEAD") {
      sendJson(response, 405, { error: "Method not allowed" });
      return;
    }
    await serveStatic(
      request,
      response,
      config.staticDirectory,
      url.pathname,
      logger,
    );
  }

  const websocket = attachWebSocketServer(server, {
    roomManager,
    getMatchLogger,
    allowedOrigins: config.allowedOrigins,
    maxConnectionsPerIp: config.maxConnectionsPerIp,
    trustProxy: config.trustProxy,
    canAcceptConnections: () =>
      acceptingConnections && roomManager.canAcceptPlayer,
    logger,
    metrics,
  });

  return {
    server,
    roomManager,
    logs,
    websocket,
    logger,
    beginShutdown() {
      acceptingConnections = false;
    },
    async close() {
      acceptingConnections = false;
      await websocket.close();
      matchManager.close();
      roomManager.close();
      metrics.close();
      await logs.close();
      await new Promise<void>((resolve) => logger.flush(() => resolve()));
    },
  };
}
