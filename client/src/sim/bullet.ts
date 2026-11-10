import type { Vector2 } from './vector.ts'
import { Entity } from './entity.ts'

export class Bullet extends Entity {
  ttl: number

  constructor(pos: Vector2, vel: Vector2, lifetime = 1.5) {
    super({
      pos,
      vel,
      angle: Math.atan2(vel.y, vel.x),
      radius: 3,
      kind: 'bullet',
    })
    this.ttl = lifetime
  }

  update(dt: number): void {
    super.update(dt)
    this.ttl -= dt
    if (this.ttl <= 0) this.alive = false
  }
}
