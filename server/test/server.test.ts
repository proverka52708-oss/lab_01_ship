import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { after, before, test } from "node:test";
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

test("HTTP server serves the client, health and live room data", async () => {
  const [page, health, roomList] = await Promise.all([
    fetch(baseUrl),
    fetch(`${baseUrl}/health`),
    fetch(`${baseUrl}/api/rooms`),
  ]);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Star Runner test/);
  assert.deepEqual(await health.json(), { status: "ok" });
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
  const replayResponse = await fetch(`${baseUrl}/api/matches/${secondJoin.matchId}/replay`);
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

test("malformed JSON is logged and closes the WebSocket", async () => {
  const socket = await connectSocket();
  const closed = once(socket, "close");
  const loggedErrors: string[] = [];
  const originalError = console.error;
  console.error = (...values: unknown[]) => {
    loggedErrors.push(values.map(String).join(" "));
  };
  try {
    socket.send('{"type":');
    assert.equal((await closed)[0], 1007);
    assert.ok(loggedErrors.some((message) => message.includes("malformed JSON")));
  } finally {
    console.error = originalError;
  }
});

test("invalid binary WebSocket packets close with a protocol error", async () => {
  const socket = await connectSocket();
  const closed = once(socket, "close");
  socket.send(Buffer.from([0]));
  assert.equal((await closed)[0], 1002);
});

test("server configuration validates PORT and LOG_DIR", () => {
  assert.throws(() => loadConfig({ PORT: "70000", LOG_DIR: "logs" }), /PORT/);
  assert.throws(() => loadConfig({ PORT: "3000", LOG_DIR: "" }), /LOG_DIR/);
});
