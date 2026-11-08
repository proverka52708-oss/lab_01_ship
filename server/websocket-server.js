import { WebSocketServer } from "ws";

const MAX_MESSAGE_BYTES = 1024;
const RATE_LIMIT_PER_SECOND = 20;
const MAX_BUFFERED_BYTES = 128 * 1024;
const JOIN_TIMEOUT_MS = 5000;

function closeForProtocol(socket, code, reason) {
  if (socket.readyState === 1 || socket.readyState === 0) {
    socket.close(code, reason);
  }
}

function parseMessage(data, isBinary) {
  if (isBinary) return { error: { code: 1003, reason: "Text messages only" } };
  if (data.length > MAX_MESSAGE_BYTES) {
    return { error: { code: 1009, reason: "Message exceeds 1024 bytes" } };
  }

  let message;
  try {
    message = JSON.parse(data.toString("utf8"));
  } catch {
    return { error: { code: 1007, reason: "Invalid JSON" } };
  }
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    return { error: { code: 1008, reason: "Message must be a JSON object" } };
  }

  const keys = Object.keys(message);
  if (message.type === "join") {
    if (
      keys.some((key) => !["type", "roomId", "playerName"].includes(key)) ||
      typeof message.roomId !== "string" ||
      !/^[a-z0-9-]{1,32}$/.test(message.roomId) ||
      typeof message.playerName !== "string" ||
      message.playerName.trim().length < 1 ||
      message.playerName.trim().length > 18
    ) {
      return { error: { code: 1008, reason: "Invalid join message" } };
    }
    return { value: { ...message, playerName: message.playerName.trim() } };
  }

  if (message.type === "leave") {
    if (keys.length !== 1)
      return { error: { code: 1008, reason: "Invalid leave message" } };
    return { value: message };
  }

  if (message.type === "chat") {
    if (
      keys.some((key) => !["type", "text"].includes(key)) ||
      typeof message.text !== "string" ||
      message.text.trim().length < 1 ||
      message.text.trim().length > 300
    ) {
      return { error: { code: 1008, reason: "Invalid chat message" } };
    }
    return { value: { ...message, text: message.text.trim() } };
  }

  return { error: { code: 1008, reason: "Unknown message type" } };
}

export function attachWebSocketServer(server, { roomManager, getMatchLogger }) {
  const websocketServer = new WebSocketServer({
    noServer: true,
    maxPayload: 2048,
    perMessageDeflate: false,
  });
  const connections = new Map();

  server.on("upgrade", (request, socket, head) => {
    let pathname;
    try {
      pathname = new URL(request.url, "http://localhost").pathname;
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
    const state = {
      alive: true,
      missedPongs: 0,
      room: null,
      player: null,
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

    client.on("message", (data, isBinary) => {
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
      if (parsed.error) {
        closeForProtocol(client, parsed.error.code, parsed.error.reason);
        return;
      }
      void handleMessage(client, state, parsed.value, joinTimer).catch(
        (error) => {
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

  async function handleMessage(client, state, message, joinTimer) {
    if (message.type === "join") {
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
      clearTimeout(joinTimer);
      return;
    }

    if (message.type === "leave") {
      state.room?.leave(client);
      state.room = null;
      state.player = null;
      return;
    }

    if (message.type === "chat") {
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
