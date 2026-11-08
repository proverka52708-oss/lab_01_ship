import { Vector2 } from './vector.js'

export function wrapPosition(ship, width, height) {
  if (ship.pos.x < 0) ship.pos.x += width
  if (ship.pos.x > width) ship.pos.x -= width
  if (ship.pos.y < 0) ship.pos.y += height
  if (ship.pos.y > height) ship.pos.y -= height
}

export function bounceAtBounds(entity, width, height) {
  const { pos, vel, radius } = entity

  if (pos.x - radius < 0) {
    pos.x = radius
    entity.vel = new Vector2(Math.abs(vel.x), vel.y)
  } else if (pos.x + radius > width) {
    pos.x = width - radius
    entity.vel = new Vector2(-Math.abs(vel.x), vel.y)
  }

  if (pos.y - radius < 0) {
    pos.y = radius
    entity.vel = new Vector2(entity.vel.x, Math.abs(entity.vel.y))
  } else if (pos.y + radius > height) {
    pos.y = height - radius
    entity.vel = new Vector2(entity.vel.x, -Math.abs(entity.vel.y))
  }
}
