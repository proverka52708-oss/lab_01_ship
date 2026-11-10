import test from "node:test";
import assert from "node:assert/strict";
import {
  BINARY_PACKET_SPEC,
  decodeBinary,
  decodeJson,
  encodeBinary,
  encodeJson,
  measureJsonBytes,
  type DecodedBinaryMessage,
} from "../src/codec.ts";

type DecodedSnapshot = Extract<DecodedBinaryMessage, { type: "snapshot" }>;

function decodeSnapshot(data: ArrayBuffer | ArrayBufferView): DecodedSnapshot {
  const message = decodeBinary(data);
  if (message.type !== "snapshot")
    throw new TypeError("Expected a snapshot packet.");
  return message;
}

function firstEntity(snapshot: DecodedSnapshot) {
  const entity = snapshot.entities[0];
  if (!entity) throw new RangeError("Expected at least one snapshot entity.");
  return entity;
}

function firstPickup(snapshot: DecodedSnapshot) {
  const entity = firstEntity(snapshot);
  if (entity.kind !== "pickup")
    throw new TypeError("Expected a pickup entity.");
  return entity;
}

const sampleSnapshot = {
  type: "snapshot",
  tick: 42,
  acks: [{ entityId: 7, seq: 23 }],
  entities: [
    {
      id: 7,
      kind: "ship",
      x: 123.25,
      y: 80.5,
      vx: 4.25,
      vy: -2.5,
      angle: Math.PI - 0.00004,
      radius: 13,
      hp: 3,
      thrust: 1,
      invulnerableTime: 0.25,
      shield: false,
      ownerId: 0,
      commandSeq: 0,
      score: 100,
      ttl: 0,
    },
  ],
};

test("binary snapshot round-trips with little-endian fields and documented angle quantization", () => {
  const bytes = encodeBinary(sampleSnapshot);
  const decoded = decodeSnapshot(bytes);
  const entity = firstEntity(decoded);
  assert.equal(BINARY_PACKET_SPEC.endianness, "little-endian");
  assert.equal(bytes.byteLength, 10 + 8 + 50);
  assert.equal(decoded.tick, sampleSnapshot.tick);
  assert.deepEqual(decoded.acks, sampleSnapshot.acks);
  assert.equal(entity.id, 7);
  assert.ok(
    Math.abs(entity.angle - sampleSnapshot.entities[0]!.angle) <= 0.00005,
  );
  assert.ok(Math.abs(entity.x - sampleSnapshot.entities[0]!.x) < 0.001);
  assert.equal(entity.score, 100);
});

test("binary snapshots preserve pickup effects and reject values outside wire ranges", () => {
  const pickup = {
    ...sampleSnapshot.entities[0],
    id: 8,
    kind: "pickup",
    radius: 9,
    effect: "shield",
  };
  const snapshot = { ...sampleSnapshot, entities: [pickup] };
  assert.equal(
    firstPickup(decodeSnapshot(encodeBinary(snapshot))).effect,
    "shield",
  );
  assert.equal(
    firstPickup(
      decodeSnapshot(
        encodeBinary({
          ...snapshot,
          entities: [{ ...pickup, effect: "rapid-fire" }],
        }),
      ),
    ).effect,
    "rapid-fire",
  );
  assert.equal(
    firstPickup(
      decodeSnapshot(
        encodeBinary({
          ...snapshot,
          entities: [{ ...pickup, effect: "repair" }],
        }),
      ),
    ).effect,
    "repair",
  );
  assert.throws(
    () =>
      encodeBinary({
        ...snapshot,
        entities: [{ ...pickup, effect: "unknown" }],
      }),
    /snapshot entity/i,
  );
  assert.throws(
    () =>
      encodeBinary({
        ...snapshot,
        entities: [{ ...sampleSnapshot.entities[0]!, effect: "repair" }],
      }),
    /snapshot entity/i,
  );
  const missingEffect = encodeBinary(snapshot).slice(0);
  const missingEffectView = new DataView(missingEffect);
  missingEffectView.setUint8(23, missingEffectView.getUint8(23) & 0x07);
  assert.throws(() => decodeBinary(missingEffect), /flags/i);
  assert.throws(
    () => encodeBinary({ ...snapshot, tick: 0x1_0000_0000 }),
    /snapshot fields/i,
  );
  assert.throws(
    () =>
      encodeBinary({
        ...snapshot,
        entities: [{ ...pickup, id: 0x1_0000_0000 }],
      }),
    /snapshot entity/i,
  );
  assert.throws(
    () => encodeBinary({ ...snapshot, entities: [{ ...pickup, radius: -1 }] }),
    /snapshot entity/i,
  );
  assert.throws(
    () => encodeBinary({ ...snapshot, entities: [{ ...pickup, score: -1 }] }),
    /snapshot entity/i,
  );
  assert.throws(
    () =>
      encodeBinary({
        ...snapshot,
        acks: [{ entityId: 7, seq: 0x1_0000_0000 }],
      }),
    /acknowledgement/i,
  );
  assert.throws(
    () => encodeBinary({ type: "pong", tick: 0x1_0000_0000, sentAt: 1 }),
    /pong fields/i,
  );
});

test("input, ping, and pong binary packets round-trip and reject malformed fields", () => {
  const input = {
    type: "input",
    seq: 900,
    tick: 300,
    turn: -1,
    thrust: true,
    brake: false,
    fire: true,
  };
  assert.deepEqual(decodeBinary(encodeBinary(input)), input);
  for (const packet of [
    { type: "ping", sentAt: 12.5 },
    { type: "pong", tick: 7, sentAt: 12.5 },
  ]) {
    assert.deepEqual(decodeBinary(encodeBinary(packet)), packet);
  }
  assert.throws(() => encodeBinary({ ...input, turn: 2 }), /turn/i);
  assert.throws(() => decodeBinary(new Uint8Array([0, 1, 0])), /version/i);
  assert.throws(
    () => decodeBinary(new Uint8Array([1, 2, 0])),
    /truncated|length/i,
  );
  const malformedFlags = new Uint8Array(12);
  malformedFlags[0] = 1;
  malformedFlags[1] = 1;
  malformedFlags[11] = 0x80;
  assert.throws(() => decodeBinary(malformedFlags), /flags/i);
});

test("JSON codec uses UTF-8 bytes for measurement and preserves snapshot content", () => {
  const encoded = encodeJson({ type: "chat", name: "Пілот", text: "Привіт" });
  assert.deepEqual(decodeJson(encoded), {
    type: "chat",
    name: "Пілот",
    text: "Привіт",
  });
  assert.equal(
    measureJsonBytes(sampleSnapshot),
    new TextEncoder().encode(JSON.stringify(sampleSnapshot)).length,
  );
  assert.throws(
    () =>
      decodeJson(
        JSON.stringify({
          type: "input",
          seq: 1,
          tick: 0,
          turn: 2,
          thrust: false,
          brake: false,
          fire: false,
        }),
      ),
    /invalid/i,
  );
  const joined = {
    type: "joined",
    room: {
      id: "room-a",
      name: "Room A",
      players: 1,
      capacity: 8,
      arena: "standard",
    },
    player: { id: "pilot-a", name: "Pilot" },
    matchId: "match-a",
  };
  assert.deepEqual(decodeJson(JSON.stringify(joined)), joined);
  const serverChat = {
    type: "chat",
    roomId: "room-a",
    player: "Pilot",
    text: "Ready!",
    timestamp: "2026-11-10T12:00:00.000Z",
  };
  assert.deepEqual(decodeJson(JSON.stringify(serverChat)), serverChat);
});
