import { createReadStream, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, resolve, sep } from "node:path";
import { pipeline } from "node:stream";
import { MatchLogManager } from "./match-logger.js";
import { MatchManager } from "./match.js";
import { RoomManager } from "./room-manager.js";
import { attachWebSocketServer } from "./websocket-server.js";

const MIME_TYPES = new Map([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".ico", "image/x-icon"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
  [".wav", "audio/wav"],
]);
const MAX_BODY_BYTES = 8 * 1024;

function sendJson(response, statusCode, value) {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  response.end(JSON.stringify(value));
}

async function readJsonBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES)
      throw Object.assign(new Error("Request body is too large"), {
        statusCode: 413,
      });
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw Object.assign(new Error("Request body must be valid JSON"), {
      statusCode: 400,
    });
  }
}

function resolveStaticPath(staticDirectory, pathname) {
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

async function serveStatic(request, response, staticDirectory, pathname) {
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
      console.error(`Static file stream failed (${filePath}):`, error.message);
      response.destroy(error);
    }
  });
}

function testEndpoint(request, response, pathname) {
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

export async function createApplication(config) {
  const roomManager = await new RoomManager().load(config.roomDefinitions);
  const matchManager = new MatchManager(roomManager);
  const logs = new MatchLogManager(config.logDirectory);
  const activeLogs = new Map();
  roomManager.on("room-removed", (room) => activeLogs.delete(room.id));

  async function getMatchLogger(roomId) {
    if (!activeLogs.has(roomId)) {
      activeLogs.set(
        roomId,
        logs.open(roomId).then((logger) => {
          for (const eventName of ["join", "leave", "chat", "slow-client"]) {
            const handler = (event) => {
              void logger
                .append({ ...event, type: eventName })
                .catch((error) => logger.emit("error", error));
            };
            roomManager.get(roomId)?.on(eventName, handler);
          }
          return logger;
        }),
      );
    }
    return activeLogs.get(roomId);
  }

  const server = createServer(async (request, response) => {
    let rawPath;
    try {
      rawPath = decodeURIComponent(request.url.split("?")[0]);
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
      url = new URL(request.url, "http://localhost");
    } catch {
      sendJson(response, 400, { error: "Invalid request URL" });
      return;
    }

    if (url.pathname === "/health" && request.method === "GET") {
      sendJson(response, 200, { status: "ok" });
      return;
    }
    if (url.pathname.startsWith("/api/test/") && request.method === "GET") {
      if (testEndpoint(request, response, url.pathname)) return;
    }
    if (url.pathname === "/api/rooms") {
      if (request.method === "GET") {
        sendJson(response, 200, { rooms: roomManager.list() });
        return;
      }
      if (url.pathname === "/api/matches/stats" && request.method === "GET") {
        sendJson(response, 200, matchManager.stats());
        return;
      }
      if (request.method === "POST") {
        try {
          const body = await readJsonBody(request);
          const room = roomManager.create({
            id: body.id,
            name: body.name,
            capacity: body.capacity ?? 4,
            arena: body.arena ?? "standard",
          });
          sendJson(response, 201, { room: room.summary });
        } catch (error) {
          sendJson(response, error.statusCode ?? 400, { error: error.message });
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
      const filePath = resolve(config.logDirectory, `${matchId}.ndjson`);
      if (!filePath.startsWith(`${resolve(config.logDirectory)}${sep}`)) {
        sendJson(response, 400, { error: "Invalid match id" });
        return;
      }
      try {
        statSync(filePath);
      } catch (error) {
        if (error.code === "ENOENT")
          sendJson(response, 404, { error: "Match log not found" });
        else sendJson(response, 500, { error: "Unable to open match log" });
        return;
      }
      response.writeHead(200, {
        "Content-Type": "application/x-ndjson; charset=utf-8",
      });
      pipeline(createReadStream(filePath), response, (error) => {
        if (error && !response.destroyed) {
          console.error(
            `Match replay stream failed (${matchId}):`,
            error.message,
          );
          response.destroy(error);
        }
      });
      return;
    }

    if (!["GET", "HEAD"].includes(request.method)) {
      sendJson(response, 405, { error: "Method not allowed" });
      return;
    }
    await serveStatic(request, response, config.staticDirectory, url.pathname);
  });

  const websocket = attachWebSocketServer(server, {
    roomManager,
    matchManager,
    getMatchLogger,
  });

  return {
    server,
    roomManager,
    logs,
    websocket,
    async close() {
      await websocket.close();
      matchManager.close();
      roomManager.close();
      await logs.close();
    },
  };
}
