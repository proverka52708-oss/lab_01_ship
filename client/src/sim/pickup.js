import { Entity } from './entity.js'
import { Vector2 } from './vector.js'

export class Pickup extends Entity {
  constructor(x, y, effect, lifetime = 20) {
    super({
      pos: new Vector2(x, y),
      radius: 14,
      kind: 'pickup',
    })
    this.effect = effect
    this.ttl = lifetime
  }

  update(dt) {
    this.angle += dt
    this.ttl -= dt
    if (this.ttl <= 0) this.alive = false
  }
}
