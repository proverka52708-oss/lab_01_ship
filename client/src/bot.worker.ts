interface StartBotsMessage {
  readonly type: "start";
  readonly roomId: string;
  readonly playerName: string;
  readonly url: string;
  readonly count: number;
}

const sockets: WebSocket[] = [];
const timers: ReturnType<typeof setInterval>[] = [];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stopBots(): void {
  while (timers.length > 0) clearInterval(timers.pop());
  while (sockets.length > 0) sockets.pop()?.close(1000, "Bots stopped");
}

function startBots(message: StartBotsMessage): void {
  stopBots();
  for (let index = 0; index < message.count; index += 1) {
    const socket = new WebSocket(message.url);
    sockets.push(socket);
    socket.addEventListener("open", () => {
      socket.send(
        JSON.stringify({
          type: "join",
          roomId: message.roomId,
          playerName: `${message.playerName.slice(0, 10)} bot ${index + 1}`,
        }),
      );
    });
    socket.addEventListener("message", (event: MessageEvent<unknown>) => {
      if (typeof event.data !== "string") return;
      let payload: unknown;
      try {
        payload = JSON.parse(event.data);
      } catch (error) {
        postMessage({
          type: "bot-error",
          message: error instanceof Error ? error.message : String(error),
        });
        return;
      }
      if (!isRecord(payload)) return;
      if (payload.type === "server-error") {
        postMessage({
          type: "bot-error",
          message:
            typeof payload.message === "string"
              ? payload.message
              : "The server rejected a bot connection.",
        });
        return;
      }
      if (payload.type !== "joined") return;
      let sequence = 0;
      const timer = setInterval(() => {
        if (socket.readyState !== WebSocket.OPEN) return;
        sequence += 1;
        socket.send(
          JSON.stringify({
            type: "input",
            seq: sequence,
            tick: sequence,
            turn: sequence % 90 < 45 ? 1 : -1,
            thrust: true,
            brake: false,
            fire: sequence % 8 === 0,
          }),
        );
      }, 1000 / 30);
      timers.push(timer);
      postMessage({ type: "bot-connected" });
    });
  }
}

globalThis.addEventListener("message", (event: MessageEvent<unknown>) => {
  const message = event.data;
  if (!isRecord(message) || typeof message.type !== "string") return;
  if (message.type === "stop") {
    stopBots();
    postMessage({ type: "bots-stopped" });
  } else if (message.type === "start") {
    if (
      typeof message.roomId !== "string" ||
      typeof message.playerName !== "string" ||
      typeof message.url !== "string" ||
      typeof message.count !== "number" ||
      !Number.isInteger(message.count) ||
      message.count < 1 ||
      message.count > 8
    ) {
      return;
    }
    startBots({
      type: "start",
      roomId: message.roomId,
      playerName: message.playerName,
      url: message.url,
      count: message.count,
    });
  }
});
