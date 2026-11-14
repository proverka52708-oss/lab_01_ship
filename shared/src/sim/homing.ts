import type { Entity } from "./entity.ts";
import type { World } from "./world.ts";
import type { HomingOptions, HomingSnapshot } from "./snapshot-types.ts";

export interface HomingBehavior extends HomingSnapshot {
  update(entity: Entity, world: World, dt: number): void;
}

export interface HomingEntity extends Entity {
  homing?: HomingBehavior;
}

function shortestAngleDifference(from: number, to: number): number {
  return Math.atan2(Math.sin(to - from), Math.cos(to - from));
}

export function createHomingBehavior({
  targetKind,
  turnRate = 2.5,
  acceleration = 0,
  maxSpeed = 300,
}: HomingOptions): HomingBehavior {
  if (!targetKind) {
    throw new TypeError("A homing behavior needs a target kind.");
  }

  return {
    targetKind,
    turnRate,
    acceleration,
    maxSpeed,
    update(entity: Entity, world: World, dt: number): void {
      let target = null;
      let nearestDistanceSquared = Infinity;

      for (const candidate of world.ofKind(targetKind)) {
        if (candidate.id === entity.id) {
          continue;
        }
        const dx = candidate.pos.x - entity.pos.x;
        const dy = candidate.pos.y - entity.pos.y;
        const distanceSquared = dx * dx + dy * dy;
        if (distanceSquared < nearestDistanceSquared) {
          nearestDistanceSquared = distanceSquared;
          target = candidate;
        }
      }

      if (!target) {
        return;
      }

      const directionX = target.pos.x - entity.pos.x;
      const directionY = target.pos.y - entity.pos.y;
      if (directionX === 0 && directionY === 0) {
        return;
      }
      const desiredAngle = Math.atan2(directionY, directionX);
      const angleChange = shortestAngleDifference(entity.angle, desiredAngle);
      entity.angle += Math.max(
        -turnRate * dt,
        Math.min(turnRate * dt, angleChange),
      );

      const speed = Math.min(
        maxSpeed,
        Math.hypot(entity.vel.x, entity.vel.y) + acceleration * dt,
      );
      entity.vel.set(
        Math.cos(entity.angle) * speed,
        Math.sin(entity.angle) * speed,
      );
    },
  };
}

export function attachHoming<T extends HomingEntity>(
  entity: T,
  behavior: HomingBehavior,
): T {
  if (!behavior || typeof behavior.update !== "function") {
    throw new TypeError("A homing component must provide an update function.");
  }
  entity.homing = behavior;
  return entity;
}
