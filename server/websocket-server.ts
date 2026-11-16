import { WebSocket, WebSocketServer, type RawData } from "ws";
import type { IncomingMessage, Server } from "node:http";
import { isIP } from "node:net";
import type { Logger } from "pino";
import {
  decodeBinary,
  encodeBinary,
  type BinaryMessage,
} from "@dogfight/shared/codec";
import { parseClientMessage } from "@dogfight/shared/protocol";
import type { ClientMessage } from "@dogfight/shared/protocol";
import type { Room, RoomPlayer } from "./room.ts";
import type { RoomManager } from "./room-manager.ts";
import type { MatchLogger } from "./match-logger.ts";
import type { ServerMetrics } from "./metrics.ts";

const MAX_MESSAGE_BYTES = 1024;
const RATE_LIMIT_PER_SECOND = 45;
const MAX_BUFFERED_BYTES = 128 * 1024;
const JOIN_TIMEOUT_MS = 5000;

interface ConnectionState {
  alive: boolean;
  missedPongs: number;
  room: Room | null;
  player: RoomPlayer | null;
  codec: "json" | "binary";
  messageTimes: number[];
}

interface ProtocolError {
  code: number;
  reason: string;
}

interface SnapshotMessage {
  type: "snapshot";
  [key: string]: unknown;
}

type ParseResult = { value: ClientMessage } | { error: ProtocolError };

function assertNever(value: never): never {
  throw new Error(`Unexpected client message: ${JSON.stringify(value)}`);
}

function closeForProtocol(
  socket: WebSocket,
  code: number,
  reason: string,
): void {
  if (socket.readyState === 1 || socket.readyState === 0) {
    socket.close(code, reason);
  }
}

function asBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  return Buffer.concat(data);
}

function parseMessage(data: RawData, isBinary: boolean): ParseResult {
  const buffer = asBuffer(data);
  if (isBinary) {
    try {
      const message = decodeBinary(buffer);
      switch (message.type) {
        case "input":
        case "ping":
          return { value: parseClientMessage(message) };
        case "snapshot":
        case "pong":
          return {
            error: { code: 1003, reason: "Unsupported client packet" },
          };
        default:
          return assertNever(message satisfies BinaryMessage);
      }
    } catch {
      return { error: { code: 1002, reason: "Invalid binary packet" } };
    }
  }
  if (buffer.length > MAX_MESSAGE_BYTES) {
    return { error: { code: 1009, reason: "Message exceeds 1024 bytes" } };
  }

  let message: unknown;
  try {
    message = JSON.parse(buffer.toString("utf8"));
  } catch {
    return { error: { code: 1007, reason: "Invalid JSON" } };
  }
  try {
    return { value: parseClientMessage(message) };
  } catch {
    return { error: { code: 1008, reason: "Invalid client message" } };
  }
}

export function attachWebSocketServer(
  server: Server,
  {
    roomManager,
    getMatchLogger,
    allowedOrigins = [],
    maxConnectionsPerIp = 16,
    trustProxy = false,
    canAcceptConnections = () => true,
    logger,
    metrics,
  }: {
    roomManager: RoomManager;
    getMatchLogger: (roomId: string) => Promise<MatchLogger>;
    allowedOrigins?: string[];
    maxConnectionsPerIp?: number;
    trustProxy?: boolean;
    canAcceptConnections?: () => boolean;
    logger: Logger;
    metrics: ServerMetrics;
  },
) {
  const websocketServer = new WebSocketServer({
    noServer: true,
    maxPayload: 2048,
    perMessageDeflate: false,
  });
  const connections = new Map<WebSocket, ConnectionState>();
  const connectionsByIp = new Map<string, number>();
  const roomSnapshotHandlers = new Map<
    Room,
    (snapshot: SnapshotMessage) => void
  >();

  function sendTracked(client: WebSocket, payload: string | Buffer): void {
    if (client.readyState !== WebSocket.OPEN) return;
    metrics.recordMessage(
      typeof payload === "string" ? Buffer.byteLength(payload) : payload.length,
    );
    client.send(payload);
  }

  function attachRoom(room: Room | undefined): void {
    if (!room || roomSnapshotHandlers.has(room)) return;
    const handler = (snapshot: SnapshotMessage) => {
      let binary: Buffer | null = null;
      for (const [client, state] of connections) {
        if (state.room !== room || client.readyState !== 1) continue;
        if (client.bufferedAmount > MAX_BUFFERED_BYTES) continue;
        const payload =
          state.codec === "binary"
            ? (binary ??= Buffer.from(encodeBinary(snapshot)))
            : JSON.stringify({ version: 0, ...snapshot });
        sendTracked(client, payload);
      }
    };
    room.on("snapshot", handler);
    roomSnapshotHandlers.set(room, handler);
  }

  for (const summary of roomManager.list())
    attachRoom(roomManager.get(summary.id));
  const onRoomCreated = (summary: { id: string }) =>
    attachRoom(roomManager.get(summary.id));
  roomManager.on("room-created", onRoomCreated);
  roomManager.on("room-removed", (summary: { id: string }) => {
    const room = [...roomSnapshotHandlers.keys()].find(
      (candidate) => candidate.id === summary.id,
    );
    if (!room) return;
    const handler = roomSnapshotHandlers.get(room);
    if (handler) room.off("snapshot", handler);
    roomSnapshotHandlers.delete(room);
  });

  function rejectUpgrade(
    socket: import("node:stream").Duplex,
    status: number,
    reason: string,
  ): void {
    socket.end(
      `HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
    );
  }

  function clientIp(request: IncomingMessage): string {
    if (trustProxy) {
      const forwarded = request.headers["x-forwarded-for"];
      const firstAddress =
        typeof forwarded === "string"
          ? forwarded.split(",")[0]?.trim()
          : undefined;
      if (firstAddress && isIP(firstAddress)) return firstAddress;
    }
    return request.socket.remoteAddress ?? "unknown";
  }

  function onUpgrade(
    request: IncomingMessage,
    socket: import("node:stream").Duplex,
    head: Buffer,
  ) {
    const origin = request.headers.origin;
    if (origin !== undefined && (!origin || !allowedOrigins.includes(origin))) {
      logger.warn("Rejected WebSocket upgrade from disallowed origin");
      rejectUpgrade(socket, 403, "Forbidden");
      return;
    }
    if (!canAcceptConnections()) {
      rejectUpgrade(socket, 503, "Service Unavailable");
      return;
    }
    const ip = clientIp(request);
    if ((connectionsByIp.get(ip) ?? 0) >= maxConnectionsPerIp) {
      logger.warn("Rejected WebSocket upgrade at per-IP connection limit");
      rejectUpgrade(socket, 429, "Too Many Requests");
      return;
    }
    let pathname;
    try {
      pathname = new URL(request.url ?? "/", "http://localhost").pathname;
    } catch {
      socket.destroy();
      return;
    }
    if (pathname !== "/ws") {
      socket.destroy();
      return;
    }
    websocketServer.handleUpgrade(request, socket, head, (client) => {
      connectionsByIp.set(ip, (connectionsByIp.get(ip) ?? 0) + 1);
      websocketServer.emit("connection", client, request);
    });
  }
  server.on("upgrade", onUpgrade);

  websocketServer.on("connection", (client, request: IncomingMessage) => {
    const ip = clientIp(request);
    const state: ConnectionState = {
      alive: true,
      missedPongs: 0,
      room: null,
      player: null,
      codec: "json",
      messageTimes: [],
    };
    connections.set(client, state);
    metrics.setConnections(connections.size);
    const joinTimer = setTimeout(() => {
      if (!state.room) closeForProtocol(client, 1008, "Join within 5 seconds");
    }, JOIN_TIMEOUT_MS);

    client.on("pong", () => {
      state.alive = true;
      state.missedPongs = 0;
    });

    client.on("message", (data: RawData, isBinary: boolean) => {
      const bytes = asBuffer(data).length;
      metrics.recordMessage(bytes);
      const now = Date.now();
      state.messageTimes = state.messageTimes.filter(
        (time) => now - time < 1000,
      );
      state.messageTimes.push(now);
      if (state.messageTimes.length > RATE_LIMIT_PER_SECOND) {
        closeForProtocol(client, 1008, "Message rate limit exceeded");
        return;
      }

      const parsed = parseMessage(data, isBinary);
      if ("error" in parsed) {
        logger.warn(
          {
            roomId: state.room?.id,
            playerId: state.player?.id,
            code: parsed.error.code,
          },
          "Rejected invalid WebSocket message",
        );
        closeForProtocol(client, parsed.error.code, parsed.error.reason);
        return;
      }
      void handleMessage(client, state, parsed.value, joinTimer).catch(
        (error: unknown) => {
          logger.error(
            { err: error, roomId: state.room?.id, playerId: state.player?.id },
            "WebSocket message handler failed",
          );
          if (client.readyState === 1) {
            sendTracked(
              client,
              JSON.stringify({
                type: "server-error",
                message: "Request could not be completed",
              }),
            );
          }
        },
      );
    });

    client.on("close", () => {
      clearTimeout(joinTimer);
      state.room?.leave(client);
      if (state.player) {
        logger.info(
          { roomId: state.room?.id, playerId: state.player.id },
          "WebSocket player disconnected",
        );
      }
      state.room = null;
      connections.delete(client);
      const remaining = (connectionsByIp.get(ip) ?? 1) - 1;
      if (remaining > 0) connectionsByIp.set(ip, remaining);
      else connectionsByIp.delete(ip);
      metrics.setConnections(connections.size);
    });
    client.on("error", (error) => {
      logger.warn({ err: error }, "WebSocket client error");
    });
  });

  async function handleMessage(
    client: WebSocket,
    state: ConnectionState,
    message: ClientMessage,
    joinTimer: NodeJS.Timeout,
  ): Promise<void> {
    switch (message.type) {
      case "join": {
        if (state.room) {
          sendTracked(
            client,
            JSON.stringify({
              type: "server-error",
              message: "Leave the current room first",
            }),
          );
          return;
        }
        const room = roomManager.get(message.roomId);
        if (!room) {
          sendTracked(
            client,
            JSON.stringify({ type: "server-error", message: "Room not found" }),
          );
          return;
        }
        if (!roomManager.canAcceptPlayer) {
          sendTracked(
            client,
            JSON.stringify({
              type: "server-error",
              message: "The server is at its player capacity",
            }),
          );
          return;
        }

        const matchLogger = await getMatchLogger(room.id);
        if (!roomManager.canAcceptPlayer) {
          sendTracked(
            client,
            JSON.stringify({
              type: "server-error",
              message: "The server is at its player capacity",
            }),
          );
          return;
        }
        const player = room.join(
          client,
          message.playerName,
          matchLogger.matchId,
        );
        if (!player)
          throw new Error("Unable to add player to the selected room");
        state.room = room;
        state.player = player;
        state.codec = message.codec ?? "json";
        logger.info(
          { roomId: room.id, playerId: player.id },
          "Player joined room",
        );
        clearTimeout(joinTimer);
        return;
      }
      case "leave":
        state.room?.leave(client);
        state.room = null;
        state.player = null;
        return;
      case "chat":
        if (!state.room) {
          sendTracked(
            client,
            JSON.stringify({
              type: "server-error",
              message: "Join a room before chatting",
            }),
          );
          return;
        }
        state.room.chat(client, message.text);
        return;
      case "input":
        if (!state.room?.match || !state.player) return;
        try {
          state.room.match.enqueueInput(state.player.id, message);
        } catch (error: unknown) {
          sendTracked(
            client,
            JSON.stringify({
              type: "server-error",
              message: error instanceof Error ? error.message : "Invalid input",
            }),
          );
        }
        return;
      case "ping": {
        const pong = {
          type: "pong",
          tick: state.room?.match?.tick ?? 0,
          sentAt: message.sentAt,
        };
        const payload =
          state.codec === "binary"
            ? Buffer.from(encodeBinary(pong))
            : JSON.stringify({ version: 0, ...pong });
        sendTracked(client, payload);
        return;
      }
      default:
        return assertNever(message);
    }
  }

  const heartbeat = setInterval(() => {
    for (const [client, state] of connections) {
      if (client.readyState !== 1) continue;
      if (!state.alive) {
        state.missedPongs += 1;
        if (state.missedPongs >= 2) {
          client.terminate();
          continue;
        }
      }
      state.alive = false;
      client.ping();
    }
  }, 15_000);
  heartbeat.unref();

  return {
    server: websocketServer,
    get connectionCount() {
      return connections.size;
    },
    async close() {
      clearInterval(heartbeat);
      server.off("upgrade", onUpgrade);
      roomManager.off("room-created", onRoomCreated);
      for (const [room, handler] of roomSnapshotHandlers) {
        room.off("snapshot", handler);
      }
      roomSnapshotHandlers.clear();
      const clients = [...websocketServer.clients];
      for (const client of clients) {
        if (client.readyState === WebSocket.OPEN) {
          sendTracked(
            client,
            JSON.stringify({
              type: "shutdown",
              message: "The server is restarting. Returning to the lobby.",
            }),
          );
        }
        client.close(1001, "Server shutting down");
      }
      const forceClose = setTimeout(() => {
        for (const client of clients) {
          if (client.readyState !== 3) client.terminate();
        }
      }, 3000);
      await new Promise((resolve) => websocketServer.close(resolve));
      clearTimeout(forceClose);
    },
  };
}
