import { WebSocket, WebSocketServer, type RawData } from "ws";
import type { Server } from "node:http";
import {
  decodeBinary,
  encodeBinary,
  type BinaryMessage,
} from "@dogfight/shared/codec";
import { parseClientMessage } from "@dogfight/shared/protocol";
import type { ClientMessage } from "@dogfight/shared/protocol";
import type { Room } from "./room.ts";
import type { RoomManager } from "./room-manager.ts";
import type { MatchLogger } from "./match-logger.ts";

const MAX_MESSAGE_BYTES = 1024;
const RATE_LIMIT_PER_SECOND = 45;
const MAX_BUFFERED_BYTES = 128 * 1024;
const JOIN_TIMEOUT_MS = 5000;

interface ConnectionState {
  alive: boolean;
  missedPongs: number;
  room: Room | null;
  player: ReturnType<Room["join"]> | null;
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

type ParseResult =
  | { value: ClientMessage }
  | { error: ProtocolError };

function assertNever(value: never): never {
  throw new Error(`Unexpected client message: ${JSON.stringify(value)}`);
}

function closeForProtocol(socket: WebSocket, code: number, reason: string): void {
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
    console.error("WebSocket message contains malformed JSON");
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
  }: {
    roomManager: RoomManager;
    getMatchLogger: (roomId: string) => Promise<MatchLogger>;
  },
) {
  const websocketServer = new WebSocketServer({
    noServer: true,
    maxPayload: 2048,
    perMessageDeflate: false,
  });
  const connections = new Map<WebSocket, ConnectionState>();
  const roomSnapshotHandlers = new Map<Room, (snapshot: SnapshotMessage) => void>();

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
        client.send(payload);
      }
    };
    room.on("snapshot", handler);
    roomSnapshotHandlers.set(room, handler);
  }

  for (const summary of roomManager.list()) attachRoom(roomManager.get(summary.id));
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

  server.on("upgrade", (request, socket, head) => {
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
      websocketServer.emit("connection", client, request);
    });
  });

  websocketServer.on("connection", (client) => {
    const state: ConnectionState = {
      alive: true,
      missedPongs: 0,
      room: null,
      player: null,
      codec: "json",
      messageTimes: [],
    };
    connections.set(client, state);
    const joinTimer = setTimeout(() => {
      if (!state.room) closeForProtocol(client, 1008, "Join within 5 seconds");
    }, JOIN_TIMEOUT_MS);

    client.on("pong", () => {
      state.alive = true;
      state.missedPongs = 0;
    });

    client.on("message", (data: RawData, isBinary: boolean) => {
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
        closeForProtocol(client, parsed.error.code, parsed.error.reason);
        return;
      }
      void handleMessage(client, state, parsed.value, joinTimer).catch(
        (error: unknown) => {
          console.error("WebSocket message handler failed:", error);
          if (client.readyState === 1) {
            client.send(
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
      state.room = null;
      connections.delete(client);
    });
    client.on("error", (error) => {
      console.error("WebSocket client error:", error.message);
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
          client.send(
            JSON.stringify({
              type: "server-error",
              message: "Leave the current room first",
            }),
          );
          return;
        }
        const room = roomManager.get(message.roomId);
        if (!room) {
          client.send(
            JSON.stringify({ type: "server-error", message: "Room not found" }),
          );
          return;
        }

        const logger = await getMatchLogger(room.id);
        const player = room.join(client, message.playerName, logger.matchId);
        state.room = room;
        state.player = player;
        state.codec = message.codec ?? "json";
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
          client.send(
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
          client.send(
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
        client.send(
          state.codec === "binary"
            ? Buffer.from(encodeBinary(pong))
            : JSON.stringify({ version: 0, ...pong }),
        );
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
    async close() {
      clearInterval(heartbeat);
      roomManager.off("room-created", onRoomCreated);
      for (const [room, handler] of roomSnapshotHandlers) {
        room.off("snapshot", handler);
      }
      roomSnapshotHandlers.clear();
      const clients = [...websocketServer.clients];
      for (const client of clients) {
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
