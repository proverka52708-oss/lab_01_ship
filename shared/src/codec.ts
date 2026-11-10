import { z } from "zod";
import { BINARY_PROTOCOL_VERSION, MESSAGE_KIND } from "./protocol.ts";
import {
  ClientMessageSchema,
  GameSnapshotSchema,
  InputMessageSchema,
  SnapshotEntitySchema,
  type GameSnapshot,
  type SnapshotEntity,
} from "./types.ts";

const HEADER_BYTES = 2;
const SNAPSHOT_HEADER_BYTES = 10;
const ACK_BYTES = 8;
const ENTITY_BYTES = 50;
const ANGLE_SCALE = 10_000;
const TEXT_ENCODER = new TextEncoder();
const TEXT_DECODER = new TextDecoder("utf-8", { fatal: true });

type PickupEffect = Extract<SnapshotEntity, { kind: "pickup" }>["effect"];

const ENTITY_KINDS: SnapshotEntity["kind"][] = [
  "ship",
  "asteroid",
  "bullet",
  "pickup",
  "explosion",
];
const PICKUP_EFFECTS: PickupEffect[] = ["shield", "rapid-fire", "repair"];
const entityKindIds = new Map<SnapshotEntity["kind"], number>();
ENTITY_KINDS.forEach((kind, index) => entityKindIds.set(kind, index + 1));
const pickupEffectIds = new Map<PickupEffect, number>();
PICKUP_EFFECTS.forEach((effect, index) =>
  pickupEffectIds.set(effect, index + 1),
);

const versionSchema = z.literal(0).optional();
const pingSchema = z
  .object({
    type: z.literal("ping"),
    version: versionSchema,
    sentAt: z.number().finite(),
  })
  .strict();
const pongSchema = z
  .object({
    type: z.literal("pong"),
    version: versionSchema,
    tick: z.number().int().safe().min(0).max(0xffffffff),
    sentAt: z.number().finite(),
  })
  .strict();
const snapshotMessageSchema = GameSnapshotSchema.extend({
  version: versionSchema,
});
const playerSchema = z
  .object({ id: z.string().min(1), name: z.string().min(1) })
  .strict();
const roomSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    players: z.number().int().nonnegative(),
    capacity: z.number().int().positive(),
    arena: z.enum(["standard", "wide", "compact"]),
  })
  .strict();
const serverMessageSchema = z.union([
  z
    .object({
      type: z.literal("joined"),
      room: roomSchema,
      player: playerSchema,
      matchId: z.string().min(1),
    })
    .strict(),
  z.object({ type: z.literal("player-joined"), player: playerSchema }).strict(),
  z.object({ type: z.literal("player-left"), player: playerSchema }).strict(),
  z.object({ type: z.literal("server-error"), message: z.string() }).strict(),
]);
const chatJsonSchema = z
  .object({
    type: z.literal("chat"),
    text: z.string().trim().min(1).max(300),
  })
  .passthrough();
const binaryMessageSchema = z.discriminatedUnion("type", [
  InputMessageSchema,
  pingSchema,
  pongSchema,
  snapshotMessageSchema,
]);

export type BinaryMessage = z.infer<typeof binaryMessageSchema>;
export type DecodedBinaryMessage = BinaryMessage;

export const BINARY_PACKET_SPEC = Object.freeze({
  version: BINARY_PROTOCOL_VERSION,
  endianness: "little-endian",
  angleScale: ANGLE_SCALE,
  snapshotHeaderBytes: SNAPSHOT_HEADER_BYTES,
  entityBytes: ENTITY_BYTES,
  ackBytes: ACK_BYTES,
});

export function encodeBinary(message: unknown): ArrayBuffer {
  const parsed = binaryMessageSchema.safeParse(message);
  if (!parsed.success) {
    const type = isRecord(message) ? message.type : undefined;
    if (type === "snapshot") {
      const path = parsed.error.issues[0]?.path[0];
      if (path === "entities")
        throw new TypeError("Snapshot entity is invalid.");
      if (path === "acks")
        throw new TypeError("Snapshot acknowledgement is invalid.");
      throw new TypeError("Snapshot fields are invalid.");
    }
    if (type === "pong") throw new TypeError("Pong fields are invalid.");
    if (type === "ping") throw new TypeError("Ping timestamp is invalid.");
    if (type === "input") {
      const field = parsed.error.issues[0]?.path[0];
      throw new TypeError(
        `Input ${typeof field === "string" ? field : "command"} is invalid.`,
      );
    }
    throw new TypeError("Unsupported binary message type.");
  }

  const validMessage = parsed.data;
  switch (validMessage.type) {
    case "input": {
      const buffer = new ArrayBuffer(HEADER_BYTES + 10);
      const view = new DataView(buffer);
      view.setUint8(0, BINARY_PROTOCOL_VERSION);
      view.setUint8(1, MESSAGE_KIND.input);
      view.setUint32(2, validMessage.seq, true);
      view.setUint32(6, validMessage.tick, true);
      view.setInt8(10, validMessage.turn);
      view.setUint8(
        11,
        Number(validMessage.thrust) |
          (Number(validMessage.brake) << 1) |
          (Number(validMessage.fire) << 2),
      );
      return buffer;
    }
    case "ping": {
      const buffer = new ArrayBuffer(HEADER_BYTES + 8);
      const view = new DataView(buffer);
      view.setUint8(0, BINARY_PROTOCOL_VERSION);
      view.setUint8(1, MESSAGE_KIND.ping);
      view.setFloat64(2, validMessage.sentAt, true);
      return buffer;
    }
    case "pong": {
      const buffer = new ArrayBuffer(HEADER_BYTES + 12);
      const view = new DataView(buffer);
      view.setUint8(0, BINARY_PROTOCOL_VERSION);
      view.setUint8(1, MESSAGE_KIND.pong);
      view.setUint32(2, validMessage.tick, true);
      view.setFloat64(6, validMessage.sentAt, true);
      return buffer;
    }
    case "snapshot":
      return encodeSnapshot(validMessage);
    default:
      return assertNever(validMessage);
  }
}

function encodeSnapshot(message: GameSnapshot): ArrayBuffer {
  if (message.entities.length > 1000 || message.acks.length > 64) {
    throw new TypeError("Snapshot fields are invalid.");
  }
  const buffer = new ArrayBuffer(
    SNAPSHOT_HEADER_BYTES +
      message.acks.length * ACK_BYTES +
      message.entities.length * ENTITY_BYTES,
  );
  const view = new DataView(buffer);
  view.setUint8(0, BINARY_PROTOCOL_VERSION);
  view.setUint8(1, MESSAGE_KIND.snapshot);
  view.setUint32(2, message.tick, true);
  view.setUint16(6, message.entities.length, true);
  view.setUint16(8, message.acks.length, true);

  let offset = SNAPSHOT_HEADER_BYTES;
  for (const ack of message.acks) {
    view.setUint32(offset, ack.entityId, true);
    view.setUint32(offset + 4, ack.seq, true);
    offset += ACK_BYTES;
  }

  for (const entity of message.entities) {
    const kind = entityKindIds.get(entity.kind);
    if (kind === undefined) throw new TypeError("Snapshot entity is invalid.");
    const pickupEffect =
      entity.kind === "pickup" ? pickupEffectIds.get(entity.effect) : undefined;
    if (
      !isWireEntity(entity) ||
      (entity.kind === "pickup" && pickupEffect === undefined)
    ) {
      throw new TypeError("Snapshot entity is invalid.");
    }

    view.setUint32(offset, entity.id, true);
    view.setUint8(offset + 4, kind);
    const flags =
      Number(Boolean(entity.thrust)) |
      (Number(Boolean(entity.invulnerableTime > 0)) << 1) |
      (Number(Boolean(entity.shield)) << 2) |
      ((pickupEffect ?? 0) << 3);
    view.setUint8(offset + 5, flags);
    view.setFloat32(offset + 6, entity.x, true);
    view.setFloat32(offset + 10, entity.y, true);
    view.setFloat32(offset + 14, entity.vx, true);
    view.setFloat32(offset + 18, entity.vy, true);
    view.setFloat32(offset + 22, entity.radius, true);
    const normalizedAngle = Math.atan2(
      Math.sin(entity.angle),
      Math.cos(entity.angle),
    );
    view.setInt16(offset + 26, Math.round(normalizedAngle * ANGLE_SCALE), true);
    view.setUint8(offset + 28, entity.hp);
    view.setUint8(offset + 29, 0);
    view.setUint32(offset + 30, entity.ownerId, true);
    view.setFloat32(offset + 34, entity.ttl, true);
    view.setFloat32(offset + 38, entity.invulnerableTime, true);
    view.setUint32(offset + 42, entity.commandSeq, true);
    view.setUint32(offset + 46, entity.score, true);
    offset += ENTITY_BYTES;
  }
  return buffer;
}

export function decodeBinary(
  data: ArrayBufferLike | ArrayBufferView,
): DecodedBinaryMessage {
  const buffer = toArrayBuffer(data);
  if (buffer.byteLength < HEADER_BYTES)
    throw new RangeError("Binary packet is truncated.");
  const view = new DataView(buffer);
  if (view.getUint8(0) !== BINARY_PROTOCOL_VERSION) {
    throw new RangeError("Binary protocol version mismatch.");
  }

  switch (view.getUint8(1)) {
    case MESSAGE_KIND.input: {
      if (buffer.byteLength !== HEADER_BYTES + 10) {
        throw new RangeError("Input packet length is invalid.");
      }
      const flags = view.getUint8(11);
      if ((flags & 0xf8) !== 0)
        throw new RangeError("Input flags are invalid.");
      const input = {
        type: "input",
        seq: view.getUint32(2, true),
        tick: view.getUint32(6, true),
        turn: view.getInt8(10),
        thrust: Boolean(flags & 1),
        brake: Boolean(flags & 2),
        fire: Boolean(flags & 4),
      };
      return InputMessageSchema.parse(input);
    }
    case MESSAGE_KIND.ping: {
      if (buffer.byteLength !== HEADER_BYTES + 8) {
        throw new RangeError("Ping packet length is invalid.");
      }
      return pingSchema.parse({
        type: "ping",
        sentAt: view.getFloat64(2, true),
      });
    }
    case MESSAGE_KIND.pong: {
      if (buffer.byteLength !== HEADER_BYTES + 12) {
        throw new RangeError("Pong packet length is invalid.");
      }
      return pongSchema.parse({
        type: "pong",
        tick: view.getUint32(2, true),
        sentAt: view.getFloat64(6, true),
      });
    }
    case MESSAGE_KIND.snapshot:
      return decodeSnapshot(buffer, view);
    default:
      throw new RangeError("Binary message type is unsupported.");
  }
}

function decodeSnapshot(buffer: ArrayBuffer, view: DataView): GameSnapshot {
  if (buffer.byteLength < SNAPSHOT_HEADER_BYTES) {
    throw new RangeError("Snapshot header is truncated.");
  }
  const tick = view.getUint32(2, true);
  const entityCount = view.getUint16(6, true);
  const ackCount = view.getUint16(8, true);
  const expectedLength =
    SNAPSHOT_HEADER_BYTES + ackCount * ACK_BYTES + entityCount * ENTITY_BYTES;
  if (
    entityCount > 1000 ||
    ackCount > 64 ||
    buffer.byteLength !== expectedLength
  ) {
    throw new RangeError("Snapshot packet length or counts are invalid.");
  }

  const acks: { entityId: number; seq: number }[] = [];
  let offset = SNAPSHOT_HEADER_BYTES;
  for (let index = 0; index < ackCount; index += 1) {
    acks.push({
      entityId: view.getUint32(offset, true),
      seq: view.getUint32(offset + 4, true),
    });
    offset += ACK_BYTES;
  }

  const entities: SnapshotEntity[] = [];
  for (let index = 0; index < entityCount; index += 1) {
    const kindId = view.getUint8(offset + 4);
    const kind = ENTITY_KINDS[kindId - 1];
    const flags = view.getUint8(offset + 5);
    const pickupEffectId = (flags >> 3) & 0x03;
    if (
      kind === undefined ||
      (flags & 0xe0) !== 0 ||
      (kind === "pickup" ? pickupEffectId === 0 : pickupEffectId !== 0)
    ) {
      throw new RangeError("Snapshot entity type or flags are invalid.");
    }
    const entityData = {
      id: view.getUint32(offset, true),
      kind,
      thrust: Boolean(flags & 1),
      invulnerableTime: view.getFloat32(offset + 38, true),
      shield: Boolean(flags & 4),
      ...(kind === "pickup"
        ? { effect: PICKUP_EFFECTS[pickupEffectId - 1] }
        : {}),
      x: view.getFloat32(offset + 6, true),
      y: view.getFloat32(offset + 10, true),
      vx: view.getFloat32(offset + 14, true),
      vy: view.getFloat32(offset + 18, true),
      radius: view.getFloat32(offset + 22, true),
      angle: view.getInt16(offset + 26, true) / ANGLE_SCALE,
      hp: view.getUint8(offset + 28),
      ownerId: view.getUint32(offset + 30, true),
      ttl: view.getFloat32(offset + 34, true),
      commandSeq: view.getUint32(offset + 42, true),
      score: view.getUint32(offset + 46, true),
    };
    const parsedEntity = SnapshotEntitySchema.safeParse(entityData);
    if (!parsedEntity.success) {
      throw new RangeError("Snapshot entity values are out of range.");
    }
    entities.push(parsedEntity.data);
    offset += ENTITY_BYTES;
  }

  return GameSnapshotSchema.parse({ type: "snapshot", tick, acks, entities });
}

export function encodeJson(message: unknown): string {
  const parsed = jsonMessageSchema.safeParse(message);
  if (!parsed.success) throw new TypeError("JSON protocol message is invalid.");
  return JSON.stringify(message);
}

export function decodeJson(
  data: string | ArrayBuffer | ArrayBufferView,
): JsonProtocolMessage {
  const text =
    typeof data === "string"
      ? data
      : TEXT_DECODER.decode(
          data instanceof ArrayBuffer ? new Uint8Array(data) : data,
        );
  let message: unknown;
  try {
    message = JSON.parse(text);
  } catch {
    throw new SyntaxError("JSON protocol message is invalid.");
  }
  const parsed = jsonMessageSchema.safeParse(message);
  if (!parsed.success) throw new TypeError("JSON protocol message is invalid.");
  return parsed.data;
}

const jsonMessageSchema = z.union([
  ClientMessageSchema,
  chatJsonSchema,
  pingSchema,
  pongSchema,
  snapshotMessageSchema,
  serverMessageSchema,
]);
export type JsonProtocolMessage = z.infer<typeof jsonMessageSchema>;

export function measureJsonBytes(message: unknown): number {
  return TEXT_ENCODER.encode(encodeJson(message)).byteLength;
}

export function measureBinaryBytes(message: unknown): number {
  return encodeBinary(message).byteLength;
}

function toArrayBuffer(data: ArrayBufferLike | ArrayBufferView): ArrayBuffer {
  if (data instanceof ArrayBuffer) return data;
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(
      data.buffer,
      data.byteOffset,
      data.byteLength,
    ).slice().buffer;
  }
  throw new TypeError(
    "Binary packet must be an ArrayBuffer or typed-array view.",
  );
}

function isWireEntity(entity: SnapshotEntity): boolean {
  const floatValues = [
    entity.x,
    entity.y,
    entity.vx,
    entity.vy,
    entity.radius,
    entity.angle,
    entity.ttl,
    entity.invulnerableTime,
  ];
  return (
    floatValues.every(
      (value) =>
        Number.isFinite(value) && Math.abs(value) <= 3.4028234663852886e38,
    ) &&
    entity.radius >= 0 &&
    entity.ttl >= 0 &&
    entity.invulnerableTime >= 0 &&
    Number.isInteger(entity.hp) &&
    entity.hp >= 0 &&
    entity.hp <= 0xff &&
    isUint32(entity.ownerId) &&
    isUint32(entity.commandSeq) &&
    isUint32(entity.score)
  );
}

function isUint32(value: number): boolean {
  return Number.isInteger(value) && value >= 0 && value <= 0xffffffff;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertNever(value: never): never {
  throw new TypeError(`Unsupported binary message type: ${String(value)}`);
}
