import { Entity } from "./entity.ts";
import { createHomingBehavior } from "./homing.ts";
import { Vector2 } from "./vector.ts";
import type { HomingBehavior } from "./homing.ts";
import type { AsteroidSnapshot, EntityKind } from "./snapshot-types.ts";
import type { World } from "./world.ts";

interface AsteroidOptions {
  readonly id?: number;
  readonly radius?: number;
  readonly vel?: Vector2 | { readonly x: number; readonly y: number };
  readonly hp?: number;
  readonly homing?: HomingBehavior | null;
}

export class Asteroid extends Entity {
  readonly kind = "asteroid" satisfies EntityKind;
  #hp;
  homing?: HomingBehavior;

  constructor(
    x = 0,
    y = 0,
    {
      id,
      radius = 25,
      vel = new Vector2(),
      hp = 2,
      homing = null,
    }: AsteroidOptions = {},
  ) {
    super({ id, pos: new Vector2(x, y), vel, radius, kind: "asteroid" });
    this.#hp = hp;
    if (homing) {
      this.homing = homing;
    }
  }

  get hp() {
    return this.#hp;
  }

  takeDamage(amount = 1): boolean {
    if (!this.alive) {
      return false;
    }
    this.#hp = Math.max(0, this.#hp - amount);
    if (this.#hp === 0) {
      this.alive = false;
      return true;
    }
    return false;
  }

  update(dt: number, _input: unknown, world: World): void {
    this.homing?.update(this, world, dt);
    super.update(dt);
    if (this.pos.x < this.radius || this.pos.x > world.width - this.radius) {
      this.pos.setX(
        Math.max(this.radius, Math.min(world.width - this.radius, this.pos.x)),
      );
      this.vel.setX(-this.vel.x);
    }
    if (this.pos.y < this.radius || this.pos.y > world.height - this.radius) {
      this.pos.setY(
        Math.max(this.radius, Math.min(world.height - this.radius, this.pos.y)),
      );
      this.vel.setY(-this.vel.y);
    }
  }

  toSnapshot(): AsteroidSnapshot {
    return {
      ...super.toSnapshot(),
      kind: "asteroid",
      hp: this.#hp,
      homing: this.homing
        ? {
            targetKind: this.homing.targetKind,
            turnRate: this.homing.turnRate,
            acceleration: this.homing.acceleration,
            maxSpeed: this.homing.maxSpeed,
          }
        : null,
    };
  }

  static fromSnapshot(snapshot: AsteroidSnapshot): Asteroid {
    const asteroid = new Asteroid(snapshot.pos.x, snapshot.pos.y, {
      id: snapshot.id,
      radius: snapshot.radius,
      vel: snapshot.vel,
      hp: snapshot.hp,
      homing: snapshot.homing ? createHomingBehavior(snapshot.homing) : null,
    });
    asteroid.angle = snapshot.angle;
    asteroid.alive = snapshot.alive;
    return asteroid;
  }
}
