import { Entity } from './entity.js'

export class Bullet extends Entity {
  constructor(pos, vel, lifetime = 1.5) {
    super({
      pos,
      vel,
      angle: Math.atan2(vel.y, vel.x),
      radius: 3,
      kind: 'bullet',
    })
    this.ttl = lifetime
  }

  update(dt) {
    super.update(dt)
    this.ttl -= dt
    if (this.ttl <= 0) this.alive = false
  }
}
