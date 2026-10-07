export function circlesOverlap(first, second) {
  const dx = first.pos.x - second.pos.x
  const dy = first.pos.y - second.pos.y
  const combinedRadius = first.radius + second.radius

  return dx * dx + dy * dy <= combinedRadius * combinedRadius
}

export function resolveBulletAsteroidCollisions(world) {
  let collisionCount = 0
  const bullets = [...world.ofKind('bullet')]
  const asteroids = [...world.ofKind('asteroid')]

  for (const bullet of bullets) {
    for (const asteroid of asteroids) {
      if (!bullet.alive) break
      if (!asteroid.alive || !circlesOverlap(bullet, asteroid)) continue

      world.despawn(bullet.id)
      world.despawn(asteroid.id)
      collisionCount += 1
      break
    }
  }

  return collisionCount
}
