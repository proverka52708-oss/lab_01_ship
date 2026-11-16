import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { afterAll as after, beforeAll as before, test } from "vitest";
import WebSocket, { type RawData } from "ws";
import { z } from "zod";
import { createApplication } from "../http-server.ts";
import { loadConfig } from "../config.ts";

const ReceivedMessageSchema = z.object({
  type: z.string(),
  room: z.object({ players: z.number() }).optional(),
  matchId: z.string().optional(),
  text: z.string().optional(),
});
type ReceivedMessage = z.infer<typeof ReceivedMessageSchema>;

let temporaryDirectory: string;
let application: Awaited<ReturnType<typeof createApplication>>;
let baseUrl: string;

before(async () => {
  temporaryDirectory = await mkdtemp(join(tmpdir(), "star-runner-lab-04-"));
  const staticDirectory = join(temporaryDirectory, "public");
  const roomDefinitions = join(temporaryDirectory, "rooms.json");
  await mkdir(staticDirectory, { recursive: true });
  await writeFile(
    join(staticDirectory, "index.html"),
    "<h1>Star Runner test</h1>",
  );
  await writeFile(join(staticDirectory, "manifest.webmanifest"), "{}");
  await writeFile(
    roomDefinitions,
    JSON.stringify({
      rooms: [
        { id: "test-room", name: "Test Room", capacity: 2, arena: "standard" },
      ],
    }),
  );

  application = await createApplication({
    port: 0,
    logDirectory: join(temporaryDirectory, "logs"),
    staticDirectory,
    roomDefinitions,
    websocketPath: "/ws",
    allowedOrigins: ["https://game.example"],
    maxConnectionsPerIp: 2,
    maxPlayers: 2,
    buildSha: "test-sha",
  });
  await new Promise<void>((resolve) =>
    application.server.listen(0, "127.0.0.1", resolve),
  );
  const address = application.server.address();
  if (!address || typeof address === "string") {
    throw new Error("Server did not bind to a TCP address");
  }
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await application.close();
  await new Promise<void>((resolve, reject) => {
    application.server.close((error) => (error ? reject(error) : resolve()));
  });
  await rm(temporaryDirectory, { recursive: true, force: true });
});

function connectSocket(): Promise<WebSocket> {
  const socket = new WebSocket(baseUrl.replace("http:", "ws:") + "/ws");
  return once(socket, "open").then(() => socket);
}

function rawDataToBuffer(payload: RawData): Buffer {
  if (Buffer.isBuffer(payload)) return payload;
  if (payload instanceof ArrayBuffer) return Buffer.from(payload);
  return Buffer.concat(payload);
}

function nextMessage(
  socket: WebSocket,
  predicate: (message: ReceivedMessage) => boolean = () => true,
): Promise<ReceivedMessage> {
  return new Promise<ReceivedMessage>((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off("message", onMessage);
      reject(new Error("Timed out waiting for WebSocket message"));
    }, 2000);
    function onMessage(payload: RawData) {
      const message = ReceivedMessageSchema.parse(
        JSON.parse(rawDataToBuffer(payload).toString()),
      );
      if (!predicate(message)) return;
      clearTimeout(timer);
      socket.off("message", onMessage);
      resolve(message);
    }
    socket.on("message", onMessage);
  });
}

test("HTTP server serves the client, health, readiness, metrics and live room data", async () => {
  const [page, manifest, health, ready, metrics, roomList] = await Promise.all([
    fetch(baseUrl),
    fetch(`${baseUrl}/manifest.webmanifest`),
    fetch(`${baseUrl}/health`),
    fetch(`${baseUrl}/ready`),
    fetch(`${baseUrl}/metrics`),
    fetch(`${baseUrl}/api/rooms`),
  ]);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Star Runner test/);
  assert.match(
    manifest.headers.get("content-type") ?? "",
    /application\/manifest\+json/,
  );
  assert.deepEqual(await health.json(), { status: "ok", buildSha: "test-sha" });
  assert.equal(ready.status, 200);
  assert.equal((await ready.json()).status, "ready");
  assert.equal(metrics.status, 200);
  const metricValues = z
    .object({
      rooms: z.number(),
      players: z.number(),
      messagesPerSecond: z.number(),
      bytesPerSecond: z.number(),
      averageStepMs: z.number(),
      eventLoopUtilization: z.number(),
      eventLoopDelayP95Ms: z.number(),
      memoryBytes: z.object({ rss: z.number() }),
    })
    .parse(await metrics.json());
  assert.equal(typeof metricValues.eventLoopUtilization, "number");
  assert.deepEqual((await roomList.json()).rooms[0], {
    id: "test-room",
    name: "Test Room",
    players: 0,
    capacity: 2,
    arena: "standard",
  });
});

test("room creation validates input and rejects traversal paths", async () => {
  const created = await fetch(`${baseUrl}/api/rooms`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: "new-room", name: "New Room", capacity: 3 }),
  });
  assert.equal(created.status, 201);
  const createdBody = z
    .object({ room: z.object({ id: z.string() }) })
    .parse(await created.json());
  assert.equal(createdBody.room.id, "new-room");

  const invalid = await fetch(`${baseUrl}/api/rooms`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: "bad id", name: "Invalid" }),
  });
  assert.equal(invalid.status, 400);

  const traversal = await fetch(`${baseUrl}/..%2frooms.json`);
  assert.equal(traversal.status, 400);
});

test("WebSocket rooms broadcast chat and write replayable NDJSON logs", async () => {
  const first = await connectSocket();
  const second = await connectSocket();

  const firstJoined = nextMessage(
    first,
    (message) => message.type === "joined",
  );
  first.send(
    JSON.stringify({
      type: "join",
      roomId: "test-room",
      playerName: "Pilot One",
    }),
  );
  const firstJoin = await firstJoined;
  assert.equal(firstJoin.room?.players, 1);

  const secondJoined = nextMessage(
    second,
    (message) => message.type === "joined",
  );
  second.send(
    JSON.stringify({
      type: "join",
      roomId: "test-room",
      playerName: "Pilot Two",
    }),
  );
  const secondJoin = await secondJoined;
  assert.equal(secondJoin.room?.players, 2);

  const receivedChat = nextMessage(first, (message) => message.type === "chat");
  second.send(
    JSON.stringify({ type: "chat", text: "Hello from the other window" }),
  );
  assert.equal((await receivedChat).text, "Hello from the other window");

  first.close();
  await once(first, "close");
  assert.ok(secondJoin.matchId);
  const replayResponse = await fetch(
    `${baseUrl}/api/matches/${secondJoin.matchId}/replay`,
  );
  assert.equal(replayResponse.status, 200);
  const replay = await replayResponse.text();
  assert.match(replay, /"type":"join"/);
  assert.match(replay, /Hello from the other window/);

  second.close();
  await once(second, "close");
  const roomList = z
    .object({ rooms: z.array(z.object({ id: z.string() })) })
    .parse(await (await fetch(`${baseUrl}/api/rooms`)).json());
  const roomIds = roomList.rooms.map((room) => room.id);
  assert.equal(roomIds.includes("test-room"), false);
  assert.ok(
    await readFile(
      join(temporaryDirectory, "logs", `${secondJoin.matchId}.ndjson`),
      "utf8",
    ),
  );
});

test("unknown WebSocket message types close the socket with policy code", async () => {
  const socket = await connectSocket();
  const closed = once(socket, "close");
  socket.send(JSON.stringify({ type: "unknown" }));
  const [code] = await closed;
  assert.equal(code, 1008);
});

test("malformed and oversized WebSocket messages are rejected", async () => {
  const malformed = await connectSocket();
  const malformedClosed = once(malformed, "close");
  malformed.send(JSON.stringify({ type: "join", roomId: "test-room" }));
  assert.equal((await malformedClosed)[0], 1008);

  const oversized = await connectSocket();
  const oversizedClosed = once(oversized, "close");
  oversized.send("x".repeat(3000));
  assert.equal((await oversizedClosed)[0], 1009);
});

test("malformed JSON closes the WebSocket", async () => {
  const socket = await connectSocket();
  const closed = once(socket, "close");
  socket.send('{"type":');
  assert.equal((await closed)[0], 1007);
});

test("invalid binary WebSocket packets close with a protocol error", async () => {
  const socket = await connectSocket();
  const closed = once(socket, "close");
  socket.send(Buffer.from([0]));
  assert.equal((await closed)[0], 1002);
});

test("WebSocket accepts 30 Hz input traffic with a heartbeat", async () => {
  const socket = await connectSocket();
  for (let index = 0; index < 31; index += 1) {
    socket.send(JSON.stringify({ type: "ping", sentAt: index }));
  }
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(socket.readyState, WebSocket.OPEN);
  const closed = once(socket, "close");
  socket.close();
  await closed;
});

test("WebSocket closes clients that exceed the per-second message limit", async () => {
  const created = await fetch(`${baseUrl}/api/rooms`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: "flood-room", name: "Flood Room", capacity: 2 }),
  });
  assert.equal(created.status, 201);
  const healthy = await connectSocket();
  const healthyJoined = nextMessage(
    healthy,
    (message) => message.type === "joined",
  );
  healthy.send(
    JSON.stringify({
      type: "join",
      roomId: "flood-room",
      playerName: "Healthy",
    }),
  );
  await healthyJoined;

  const socket = await connectSocket();
  const closed = once(socket, "close");
  const room = application.roomManager.get("flood-room");
  if (!room?.match) throw new Error("Flood test match did not start");
  const initialTick = room.match.tick;
  for (let index = 0; index < 1000; index += 1) {
    socket.send(JSON.stringify({ type: "ping", sentAt: index }));
  }
  const [code] = await closed;
  assert.equal(code, 1008);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(healthy.readyState, WebSocket.OPEN);
  assert.ok(room.match.tick > initialTick);
  const healthyClosed = once(healthy, "close");
  healthy.close();
  await healthyClosed;
});

test("server configuration validates PORT and LOG_DIR", () => {
  assert.throws(() => loadConfig({ PORT: "70000", LOG_DIR: "logs" }), /PORT/);
  assert.throws(() => loadConfig({ PORT: "3000", LOG_DIR: "" }), /LOG_DIR/);
  assert.throws(
    () => loadConfig({ ALLOWED_ORIGINS: "javascript:alert(1)" }),
    /Allowed origins/,
  );
  assert.throws(
    () => loadConfig({ MAX_CONNECTIONS_PER_IP: "0" }),
    /MAX_CONNECTIONS_PER_IP/,
  );
  assert.throws(
    () => loadConfig({ NODE_ENV: "production" }),
    /ALLOWED_ORIGINS/,
  );
  assert.throws(() => loadConfig({ LOG_LEVEL: "verbose" }), /LOG_LEVEL/);
});

test("Render production config uses its assigned URL and commit SHA", () => {
  const config = loadConfig({
    NODE_ENV: "production",
    RENDER: "true",
    RENDER_EXTERNAL_URL: "https://star-runner.onrender.com",
    RENDER_GIT_COMMIT: "render-commit-sha",
    BUILD_SHA: "dev",
  });
  assert.deepEqual(config.allowedOrigins, ["https://star-runner.onrender.com"]);
  assert.equal(config.buildSha, "render-commit-sha");
});

test("WebSocket upgrade validates Origin and returns clients to ready capacity limits", async () => {
  const rejected = new WebSocket(`${baseUrl.replace("http:", "ws:")}/ws`, {
    origin: "https://attacker.example",
  });
  const [, rejectedResponse] = await once(rejected, "unexpected-response");
  assert.equal(rejectedResponse.statusCode, 403);
  rejectedResponse.resume();

  const allowed = new WebSocket(`${baseUrl.replace("http:", "ws:")}/ws`, {
    origin: "https://game.example",
  });
  await once(allowed, "open");
  const allowedClosed = once(allowed, "close");
  allowed.close();
  await allowedClosed;

  const recreated = await fetch(`${baseUrl}/api/rooms`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: "test-room", name: "Test Room", capacity: 2 }),
  });
  assert.equal(recreated.status, 201);
  const first = await connectSocket();
  const second = await connectSocket();
  const limited = new WebSocket(`${baseUrl.replace("http:", "ws:")}/ws`);
  const [, limitedResponse] = await once(limited, "unexpected-response");
  assert.equal(limitedResponse.statusCode, 429);
  limitedResponse.resume();
  const firstJoined = nextMessage(
    first,
    (message) => message.type === "joined",
  );
  const secondJoined = nextMessage(
    second,
    (message) => message.type === "joined",
  );
  first.send(
    JSON.stringify({ type: "join", roomId: "test-room", playerName: "One" }),
  );
  second.send(
    JSON.stringify({ type: "join", roomId: "test-room", playerName: "Two" }),
  );
  await Promise.all([firstJoined, secondJoined]);
  assert.equal((await fetch(`${baseUrl}/ready`)).status, 503);

  const atCapacity = new WebSocket(`${baseUrl.replace("http:", "ws:")}/ws`);
  const [, capacityResponse] = await once(atCapacity, "unexpected-response");
  assert.equal(capacityResponse.statusCode, 503);
  capacityResponse.resume();

  const firstClosed = once(first, "close");
  const secondClosed = once(second, "close");
  first.close();
  second.close();
  await Promise.all([firstClosed, secondClosed]);
  assert.equal((await fetch(`${baseUrl}/ready`)).status, 200);
});

test("graceful close sends shutdown and closes WebSockets with code 1001", async () => {
  const restartApp = await createApplication({
    port: 0,
    logDirectory: join(temporaryDirectory, "restart-logs"),
    staticDirectory: join(temporaryDirectory, "public"),
    roomDefinitions: join(temporaryDirectory, "rooms.json"),
    websocketPath: "/ws",
    allowedOrigins: ["https://game.example"],
  });
  await new Promise<void>((resolve) =>
    restartApp.server.listen(0, "127.0.0.1", resolve),
  );
  const address = restartApp.server.address();
  if (!address || typeof address === "string")
    throw new Error("Restart test server did not bind");
  const socket = new WebSocket(`ws://127.0.0.1:${address.port}/ws`);
  await once(socket, "open");
  const joined = nextMessage(socket, (message) => message.type === "joined");
  socket.send(
    JSON.stringify({ type: "join", roomId: "test-room", playerName: "Pilot" }),
  );
  await joined;

  const shutdownMessage = nextMessage(
    socket,
    (message) => message.type === "shutdown",
  );
  const closed = once(socket, "close");
  restartApp.beginShutdown();
  assert.equal(
    (await fetch(`http://127.0.0.1:${address.port}/ready`)).status,
    503,
  );
  await restartApp.close();
  assert.equal((await shutdownMessage).type, "shutdown");
  assert.equal((await closed)[0], 1001);
  await new Promise<void>((resolve, reject) => {
    restartApp.server.close((error) => (error ? reject(error) : resolve()));
  });
});
