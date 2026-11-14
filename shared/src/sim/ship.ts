import { Entity } from "./entity.ts";
import { Bullet } from "./bullet.ts";
import { Vector2 } from "./vector.ts";
import type {
  InputState,
  PickupEffect,
  ShipSnapshot,
  EntityKind,
} from "./snapshot-types.ts";
import type { World } from "./world.ts";

interface ShipOptions {
  readonly id?: number;
  readonly angle?: number;
  readonly hp?: number;
  readonly invulnerableTime?: number;
  readonly playerId?: string | null;
  readonly vel?: Vector2 | { readonly x: number; readonly y: number };
}

interface ShipPhysicsState {
  readonly x: number;
  readonly y: number;
  readonly vx: number;
  readonly vy: number;
  readonly angle: number;
  readonly thrust?: number;
}

interface WeaponState {
  cooldown: number;
  baseInterval: number;
}

const NO_INPUT: InputState = Object.freeze({ isDown: () => false });

export const SHIP_TUNING = Object.freeze({
  rotationSpeed: 4.2,
  thrustAcceleration: 280,
  drag: 0.18,
  maxSpeed: 320,
  brakeStrength: 3.5,
});

export function createShip(x = 0, y = 0): ShipPhysicsState {
  return { x, y, vx: 0, vy: 0, angle: -Math.PI / 2, thrust: 0 };
}

export class Ship extends Entity {
  readonly kind = "ship" satisfies EntityKind;
  #hp;
  #maxHp;
  playerId: string | null;
  invulnerableTime: number;
  thrust: number;
  effects: Map<PickupEffect, number>;
  weapon: WeaponState;
  score: number;

  constructor(
    x = 0,
    y = 0,
    {
      id,
      angle = -Math.PI / 2,
      hp = 3,
      invulnerableTime = 1.5,
      playerId = null,
      vel = new Vector2(),
    }: ShipOptions = {},
  ) {
    super({ id, pos: new Vector2(x, y), vel, angle, radius: 13, kind: "ship" });
    this.#hp = hp;
    this.#maxHp = hp;
    this.playerId = playerId;
    this.invulnerableTime = invulnerableTime;
    this.thrust = 0;
    this.effects = new Map();
    this.weapon = { cooldown: 0, baseInterval: 0.22 };
    this.score = 0;
  }

  get hp() {
    return this.#hp;
  }

  get maxHp() {
    return this.#maxHp;
  }

  update(
    dt: number,
    input: InputState | Map<string, InputState> = NO_INPUT,
    world?: World,
  ): void {
    if (!world) throw new TypeError("Ship.update expects a World.");
    const shipInput =
      input instanceof Map
        ? this.playerId === null
          ? undefined
          : input.get(this.playerId)
        : input;
    this.weapon.cooldown = Math.max(0, this.weapon.cooldown - dt);
    this.invulnerableTime = Math.max(0, this.invulnerableTime - dt);
    for (const [effect, remaining] of this.effects) {
      const nextRemaining = remaining - dt;
      if (nextRemaining <= 0) {
        this.effects.delete(effect);
      } else {
        this.effects.set(effect, nextRemaining);
      }
    }

    integrateShipInPlace(this, shipInput ?? NO_INPUT, dt, world.width, world.height);
  }

  fire(world: World, commandSeq = 0): Bullet | null {
    if (!this.alive || this.weapon.cooldown > 0) {
      return null;
    }

    const direction = Vector2.fromAngle(this.angle);
    const rapidFire = this.effects.has("rapid-fire");
    this.weapon.cooldown = this.weapon.baseInterval * (rapidFire ? 0.42 : 1);
    const bullet = world.createBullet({
      pos: this.pos.add(direction.scale(this.radius + 5)),
      vel: this.vel.add(direction.scale(460)),
      angle: this.angle,
      ownerId: this.id,
      commandSeq,
    });
    world.spawn(bullet);
    world.emit("fired", { ship: this, bullet });
    return bullet;
  }

  takeDamage(amount = 1): boolean {
    if (
      !this.alive ||
      this.invulnerableTime > 0 ||
      this.effects.has("shield")
    ) {
      return false;
    }

    this.#hp = Math.max(0, this.#hp - amount);
    if (this.#hp === 0) {
      this.alive = false;
      return true;
    }
    return false;
  }

  applyPickup(effect: PickupEffect, duration: number): void {
    this.effects.set(effect, duration);
  }

  repair(amount = 1): void {
    this.#hp = Math.min(this.#maxHp, this.#hp + amount);
  }

  toSnapshot(): ShipSnapshot {
    return {
      ...super.toSnapshot(),
      kind: "ship",
      hp: this.#hp,
      maxHp: this.#maxHp,
      playerId: this.playerId,
      invulnerableTime: this.invulnerableTime,
      thrust: this.thrust,
      effects: [...this.effects],
      weapon: { ...this.weapon },
      score: this.score,
    };
  }

  static fromSnapshot(snapshot: ShipSnapshot): Ship {
    const ship = new Ship(snapshot.pos.x, snapshot.pos.y, {
      id: snapshot.id,
      angle: snapshot.angle,
      hp: snapshot.hp,
      invulnerableTime: snapshot.invulnerableTime,
      playerId: snapshot.playerId,
      vel: snapshot.vel,
    });
    ship.thrust = snapshot.thrust;
    ship.effects = new Map(snapshot.effects ?? []);
    ship.weapon = { ...ship.weapon, ...snapshot.weapon };
    ship.score = snapshot.score ?? 0;
    ship.alive = snapshot.alive;
    return ship;
  }
}

function integrateState(
  ship: ShipPhysicsState,
  input: InputState,
  dt: number,
): Required<ShipPhysicsState> {
  if (!Number.isFinite(dt) || dt < 0) {
    throw new RangeError("dt must be a non-negative finite number.");
  }

  const turn =
    Number(input.isDown("ArrowRight") || input.isDown("KeyD")) -
    Number(input.isDown("ArrowLeft") || input.isDown("KeyA"));
  const isThrusting = input.isDown("ArrowUp") || input.isDown("KeyW");
  const isBraking = input.isDown("Space");
  const angle = ship.angle + turn * SHIP_TUNING.rotationSpeed * dt;
  const drag = Math.exp(
    -(SHIP_TUNING.drag + (isBraking ? SHIP_TUNING.brakeStrength : 0)) * dt,
  );
  let vx =
    (ship.vx +
      Math.cos(angle) *
        SHIP_TUNING.thrustAcceleration *
        Number(isThrusting) *
        dt) *
    drag;
  let vy =
    (ship.vy +
      Math.sin(angle) *
        SHIP_TUNING.thrustAcceleration *
        Number(isThrusting) *
        dt) *
    drag;
  const speed = Math.hypot(vx, vy);

  if (speed > SHIP_TUNING.maxSpeed) {
    const speedScale = SHIP_TUNING.maxSpeed / speed;
    vx *= speedScale;
    vy *= speedScale;
  }

  return {
    x: ship.x + vx * dt,
    y: ship.y + vy * dt,
    vx,
    vy,
    angle,
    thrust: Number(isThrusting),
  };
}

function integrateShipInPlace(
  ship: Ship,
  input: InputState,
  dt: number,
  width: number,
  height: number,
): void {
  if (!Number.isFinite(dt) || dt < 0) {
    throw new RangeError("dt must be a non-negative finite number.");
  }

  const turn =
    Number(input.isDown("ArrowRight") || input.isDown("KeyD")) -
    Number(input.isDown("ArrowLeft") || input.isDown("KeyA"));
  const isThrusting = input.isDown("ArrowUp") || input.isDown("KeyW");
  const isBraking = input.isDown("Space");
  const angle = ship.angle + turn * SHIP_TUNING.rotationSpeed * dt;
  const drag = Math.exp(
    -(SHIP_TUNING.drag + (isBraking ? SHIP_TUNING.brakeStrength : 0)) * dt,
  );
  let vx =
    (ship.vel.x +
      Math.cos(angle) *
        SHIP_TUNING.thrustAcceleration *
        Number(isThrusting) *
        dt) *
    drag;
  let vy =
    (ship.vel.y +
      Math.sin(angle) *
        SHIP_TUNING.thrustAcceleration *
        Number(isThrusting) *
        dt) *
    drag;
  const speed = Math.hypot(vx, vy);

  if (speed > SHIP_TUNING.maxSpeed) {
    const speedScale = SHIP_TUNING.maxSpeed / speed;
    vx *= speedScale;
    vy *= speedScale;
  }

  ship.angle = angle;
  ship.thrust = Number(isThrusting);
  ship.vel.set(vx, vy);
  ship.pos.set(
    ((ship.pos.x + vx * dt) % width + width) % width,
    ((ship.pos.y + vy * dt) % height + height) % height,
  );
}

// Lab 01 compatibility adapter; the class and adapter share exactly the same physics tuning.
export function integrate(
  ship: ShipPhysicsState,
  input: InputState,
  dt: number,
): Required<ShipPhysicsState> {
  return integrateState(ship, input, dt);
}

function interpolateCoordinate(
  previous: number,
  current: number,
  alpha: number,
  size: number,
): number {
  if (!size) {
    return previous + (current - previous) * alpha;
  }

  let difference = current - previous;
  if (difference > size / 2) {
    difference -= size;
  } else if (difference < -size / 2) {
    difference += size;
  }
  return (((previous + difference * alpha) % size) + size) % size;
}

export function interpolateShip(
  previous: ShipPhysicsState,
  current: ShipPhysicsState,
  alpha: number,
  width: number,
  height: number,
): Required<ShipPhysicsState> {
  const angleDifference = Math.atan2(
    Math.sin(current.angle - previous.angle),
    Math.cos(current.angle - previous.angle),
  );
  return {
    x: interpolateCoordinate(previous.x, current.x, alpha, width),
    y: interpolateCoordinate(previous.y, current.y, alpha, height),
    vx: previous.vx + (current.vx - previous.vx) * alpha,
    vy: previous.vy + (current.vy - previous.vy) * alpha,
    angle: previous.angle + angleDifference * alpha,
    thrust: alpha < 0.5 ? (previous.thrust ?? 0) : (current.thrust ?? 0),
  };
}
