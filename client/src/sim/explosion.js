import { Entity } from './entity.js'

export class Explosion extends Entity {
  constructor(pos, radius = 24, duration = 0.45) {
    super({ pos, radius, kind: 'explosion' })
    this.duration = duration
    this.ttl = duration
  }

  update(dt) {
    this.ttl -= dt
    if (this.ttl <= 0) this.alive = false
  }

  get progress() {
    return 1 - this.ttl / this.duration
  }
}
