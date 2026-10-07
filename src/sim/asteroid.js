import { Entity } from './entity.js'
import { Vector2 } from './vector.js'

export class Asteroid extends Entity {
  constructor(x, y, vel, radius = 28, rotationSpeed = 0.35) {
    super({
      pos: new Vector2(x, y),
      vel,
      radius,
      kind: 'asteroid',
    })
    this.rotationSpeed = rotationSpeed
  }

  update(dt) {
    this.angle += this.rotationSpeed * dt
    super.update(dt)
  }
}
