export function circlesOverlap(first, second) {
  const dx = first.pos.x - second.pos.x
  const dy = first.pos.y - second.pos.y
  const combinedRadius = first.radius + second.radius

  return dx * dx + dy * dy <= combinedRadius * combinedRadius
}

export function resolveCollisions(world) {
  const events = []
  const bullets = [...world.ofKind('bullet')]
  const asteroids = [...world.ofKind('asteroid')]
  const ship = [...world.ofKind('ship')][0]
  const pickups = [...world.ofKind('pickup')]

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
