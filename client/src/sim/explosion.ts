import type { Vector2 } from './vector.ts'
import { Entity } from './entity.ts'

export class Explosion extends Entity {
  duration: number
  ttl: number

  constructor(pos: Vector2, radius = 24, duration = 0.45) {
    super({ pos, radius, kind: 'explosion' })
    this.duration = duration
    this.ttl = duration
  }

  update(dt: number): void {
    this.ttl -= dt
    if (this.ttl <= 0) this.alive = false
  }

  get progress() {
    return 1 - this.ttl / this.duration
  }
}
