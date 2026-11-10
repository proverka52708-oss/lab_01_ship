import type { Entity } from './entity.ts'
import { Asteroid } from './asteroid.ts'
import { Bullet } from './bullet.ts'
import { Pickup } from './pickup.ts'
import { Ship } from './ship.ts'
import type { World } from './world.ts'

export type CollisionEvent =
  | { type: 'asteroid-hit'; asteroid: Asteroid }
  | { type: 'asteroid-destroyed'; asteroid: Asteroid }
  | { type: 'ship-hit'; ship: Ship }
  | { type: 'ship-destroyed'; ship: Ship }
  | { type: 'pickup-collected'; pickup: Pickup }

export function circlesOverlap(first: Entity, second: Entity): boolean {
  const dx = first.pos.x - second.pos.x
  const dy = first.pos.y - second.pos.y
  const combinedRadius = first.radius + second.radius

  return dx * dx + dy * dy <= combinedRadius * combinedRadius
}

export function resolveCollisions(world: World): CollisionEvent[] {
  const events: CollisionEvent[] = []
  const bullets = [...world.ofKind('bullet')].filter((entity): entity is Bullet => entity instanceof Bullet)
  const asteroids = [...world.ofKind('asteroid')].filter((entity): entity is Asteroid => entity instanceof Asteroid)
  const ship = [...world.ofKind('ship')].find((entity): entity is Ship => entity instanceof Ship)
  const pickups = [...world.ofKind('pickup')].filter((entity): entity is Pickup => entity instanceof Pickup)

  for (const bullet of bullets) {
    for (const asteroid of asteroids) {
      if (!bullet.alive) break
      if (!asteroid.alive || !circlesOverlap(bullet, asteroid)) continue

      world.despawn(bullet.id)
      const destroyed = asteroid.takeDamage(1)
      if (destroyed) world.despawn(asteroid.id)
      events.push({ type: destroyed ? 'asteroid-destroyed' : 'asteroid-hit', asteroid })
      break
    }
  }

  if (ship && !ship.destroyed) {
    for (const asteroid of asteroids) {
      if (!asteroid.alive || !circlesOverlap(ship, asteroid)) continue

      const previousHp = ship.hp
      const destroyed = ship.takeDamage(25)
      if (ship.hp < previousHp) {
        events.push({ type: destroyed ? 'ship-destroyed' : 'ship-hit', ship })
      }
      break
    }

    for (const pickup of pickups) {
      if (!pickup.alive || !circlesOverlap(ship, pickup)) continue

      ship.activatePickup(pickup.effect)
      world.despawn(pickup.id)
      events.push({ type: 'pickup-collected', pickup })
    }
  }

  return events
}
