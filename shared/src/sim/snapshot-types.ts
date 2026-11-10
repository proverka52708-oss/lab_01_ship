import type { ReadonlyVector2 } from "../types.ts";

export type PickupEffect = "shield" | "rapid-fire" | "repair";
export type EntityKind =
  "ship" | "asteroid" | "bullet" | "pickup" | "explosion";
export type TargetKind = EntityKind;

export interface InputState {
  isDown(code: string): boolean;
}

export interface HomingOptions {
  targetKind: TargetKind;
  turnRate?: number;
  acceleration?: number;
  maxSpeed?: number;
}

export interface HomingSnapshot {
  readonly targetKind: TargetKind;
  readonly turnRate: number;
  readonly acceleration: number;
  readonly maxSpeed: number;
}

export interface BaseEntitySnapshot {
  readonly id: number;
  readonly kind: EntityKind | "entity";
  readonly pos: ReadonlyVector2;
  readonly vel: ReadonlyVector2;
  readonly angle: number;
  readonly radius: number;
  readonly alive: boolean;
  readonly collidable: boolean;
}

export interface ShipSnapshot extends BaseEntitySnapshot {
  readonly kind: "ship";
  readonly hp: number;
  readonly maxHp: number;
  readonly playerId: string | null;
  readonly invulnerableTime: number;
  readonly thrust: number;
  readonly effects: readonly (readonly [PickupEffect, number])[];
  readonly weapon: { readonly cooldown: number; readonly baseInterval: number };
  readonly score: number;
}

export interface AsteroidSnapshot extends BaseEntitySnapshot {
  readonly kind: "asteroid";
  readonly hp: number;
  readonly homing: HomingSnapshot | null;
}

export interface BulletSnapshot extends BaseEntitySnapshot {
  readonly kind: "bullet";
  readonly ownerId: number | null;
  readonly commandSeq: number;
  readonly damage: number;
  readonly ttl: number;
  readonly homing: HomingSnapshot | null;
}

export interface PickupSnapshot extends BaseEntitySnapshot {
  readonly kind: "pickup";
  readonly effect: PickupEffect;
  readonly duration: number;
  readonly ttl: number;
}

export interface ExplosionParticleSnapshot {
  readonly pos: ReadonlyVector2;
  readonly vel: ReadonlyVector2;
  readonly lifetime: number;
  readonly remaining: number;
}

export interface ExplosionSnapshot extends BaseEntitySnapshot {
  readonly kind: "explosion";
  readonly particles: readonly ExplosionParticleSnapshot[];
}

export type EntitySnapshot =
  | ShipSnapshot
  | AsteroidSnapshot
  | BulletSnapshot
  | PickupSnapshot
  | ExplosionSnapshot;

export interface WorldSnapshot {
  readonly width: number;
  readonly height: number;
  readonly seed: number;
  readonly randomState: number;
  readonly nextEntityId: number;
  readonly entities: readonly EntitySnapshot[];
}
