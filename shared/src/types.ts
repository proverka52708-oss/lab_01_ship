import { z } from "zod";

declare const entityIdBrand: unique symbol;
declare const inputSeqBrand: unique symbol;
declare const simulationTickBrand: unique symbol;

export type EntityId = number & { readonly [entityIdBrand]: "EntityId" };
export type InputSeq = number & { readonly [inputSeqBrand]: "InputSeq" };
export type SimulationTick = number & {
  readonly [simulationTickBrand]: "SimulationTick";
};

export interface ReadonlyVector2 {
  readonly x: number;
  readonly y: number;
}

export function toEntityId(value: number): EntityId {
  if (!Number.isSafeInteger(value) || value < 1 || value > 0xffffffff) {
    throw new RangeError("Entity id must be a positive uint32.");
  }
  // The range check establishes the runtime invariant for this brand.
  return value as EntityId;
}

export function toInputSeq(value: number): InputSeq {
  if (!Number.isSafeInteger(value) || value < 1 || value > 0xffffffff) {
    throw new RangeError("Input sequence must be a positive uint32.");
  }
  // The range check establishes the runtime invariant for this brand.
  return value as InputSeq;
}

export function toSimulationTick(value: number): SimulationTick {
  if (!Number.isSafeInteger(value) || value < 0 || value > 0xffffffff) {
    throw new RangeError("Simulation tick must be a uint32.");
  }
  // The range check establishes the runtime invariant for this brand.
  return value as SimulationTick;
}

const uint32Schema = z.number().int().safe().min(0).max(0xffffffff);
const positiveUint32Schema = z.number().int().safe().min(1).max(0xffffffff);

export const InputCommandSchema = z
  .object({
    seq: positiveUint32Schema.transform(toInputSeq),
    tick: uint32Schema.transform(toSimulationTick),
    turn: z.union([z.literal(-1), z.literal(0), z.literal(1)]),
    thrust: z.boolean(),
    brake: z.boolean(),
    fire: z.boolean(),
  })
  .strict();

export type InputCommand = z.infer<typeof InputCommandSchema>;

export const SnapshotAckSchema = z
  .object({
    entityId: z.union([
      z.literal(0),
      positiveUint32Schema.transform(toEntityId),
    ]),
    seq: z.union([z.literal(0), positiveUint32Schema.transform(toInputSeq)]),
  })
  .strict();

export type SnapshotAck = z.infer<typeof SnapshotAckSchema>;

const snapshotIdSchema = z.union([
  z.literal(0),
  positiveUint32Schema.transform(toEntityId),
]);
const nonNegativeNumberSchema = z.number().finite().nonnegative();
const snapshotEntityBaseSchema = z
  .object({
    id: snapshotIdSchema,
    x: z.number().finite(),
    y: z.number().finite(),
    vx: z.number().finite(),
    vy: z.number().finite(),
    angle: z.number().finite(),
    radius: nonNegativeNumberSchema,
    hp: z.number().int().min(0).max(0xff).optional().default(0),
    thrust: z.union([z.number().finite(), z.boolean()]).optional().default(0),
    invulnerableTime: nonNegativeNumberSchema.optional().default(0),
    shield: z.boolean().optional().default(false),
    ownerId: snapshotIdSchema.optional().default(0),
    ttl: nonNegativeNumberSchema.optional().default(0),
    commandSeq: z
      .union([z.literal(0), positiveUint32Schema.transform(toInputSeq)])
      .optional()
      .default(0),
    score: uint32Schema.optional().default(0),
  })
  .strict();

const asteroidSnapshotEntitySchema = snapshotEntityBaseSchema
  .extend({
    kind: z.literal("asteroid"),
    homing: z
      .record(z.string(), z.union([z.number(), z.string(), z.boolean()]))
      .optional(),
  })
  .strict();

export const SnapshotEntitySchema = z.discriminatedUnion("kind", [
  snapshotEntityBaseSchema.extend({ kind: z.literal("ship") }).strict(),
  asteroidSnapshotEntitySchema,
  snapshotEntityBaseSchema.extend({ kind: z.literal("bullet") }).strict(),
  snapshotEntityBaseSchema
    .extend({
      kind: z.literal("pickup"),
      effect: z.enum(["shield", "rapid-fire", "repair"]),
    })
    .strict(),
  snapshotEntityBaseSchema.extend({ kind: z.literal("explosion") }).strict(),
]);

export type SnapshotEntity = z.infer<typeof SnapshotEntitySchema>;

export const GameSnapshotSchema = z
  .object({
    type: z.literal("snapshot"),
    tick: uint32Schema.transform(toSimulationTick),
    acks: z.array(SnapshotAckSchema),
    entities: z.array(SnapshotEntitySchema),
  })
  .strict();

export type GameSnapshot = z.infer<typeof GameSnapshotSchema>;

const versionSchema = z.literal(0).optional();

export const JoinMessageSchema = z
  .object({
    type: z.literal("join"),
    roomId: z.string().regex(/^[a-z0-9-]{1,32}$/),
    playerName: z.string().trim().min(1).max(18),
    codec: z.enum(["json", "binary"]).optional(),
  })
  .strict();

export const ChatMessageSchema = z
  .object({ type: z.literal("chat"), text: z.string().trim().min(1).max(300) })
  .strict();

export const InputMessageSchema = z
  .object({
    type: z.literal("input"),
    version: versionSchema,
    ...InputCommandSchema.shape,
  })
  .strict()
  .transform(({ version: _version, ...message }) => message);

export const PingMessageSchema = z
  .object({
    type: z.literal("ping"),
    version: versionSchema,
    sentAt: z.number().finite(),
  })
  .strict()
  .transform(({ version: _version, ...message }) => message);

export const LeaveMessageSchema = z
  .object({ type: z.literal("leave") })
  .strict();

export const ClientMessageSchema = z.discriminatedUnion("type", [
  JoinMessageSchema,
  ChatMessageSchema,
  InputMessageSchema,
  PingMessageSchema,
  LeaveMessageSchema,
]);

export type ClientMessage = z.infer<typeof ClientMessageSchema>;

export function parseClientMessage(message: unknown): ClientMessage {
  return ClientMessageSchema.parse(message);
}
