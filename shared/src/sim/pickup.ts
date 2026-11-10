import { Entity } from "./entity.ts";
import { Vector2 } from "./vector.ts";
import type {
  PickupEffect,
  PickupSnapshot,
  EntityKind,
} from "./snapshot-types.ts";
import type { Ship } from "./ship.ts";

interface PickupOptions {
  readonly id?: number;
  readonly duration?: number;
  readonly ttl?: number;
}

export class Pickup extends Entity {
  readonly kind = "pickup" satisfies EntityKind;
  effect: PickupEffect;
  duration: number;
  ttl: number;

  constructor(
    x = 0,
    y = 0,
    effect: PickupEffect = "shield",
    { id, duration = 8, ttl = 18 }: PickupOptions = {},
  ) {
    super({ id, pos: new Vector2(x, y), radius: 12, kind: "pickup" });
    this.effect = effect;
    this.duration = duration;
    this.ttl = ttl;
  }

  update(dt: number): void {
    this.ttl -= dt;
    if (this.ttl <= 0) {
      this.alive = false;
    }
  }

  applyTo(ship: Ship): void {
    if (this.effect === "repair") {
      ship.repair();
    } else {
      ship.applyPickup(this.effect, this.duration);
    }
  }

  toSnapshot(): PickupSnapshot {
    return {
      ...super.toSnapshot(),
      kind: "pickup",
      effect: this.effect,
      duration: this.duration,
      ttl: this.ttl,
    };
  }

  static fromSnapshot(snapshot: PickupSnapshot): Pickup {
    const pickup = new Pickup(snapshot.pos.x, snapshot.pos.y, snapshot.effect, {
      id: snapshot.id,
      duration: snapshot.duration,
      ttl: snapshot.ttl,
    });
    pickup.alive = snapshot.alive;
    return pickup;
  }
}
