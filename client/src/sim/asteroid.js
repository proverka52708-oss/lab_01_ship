import { Entity } from './entity.js'
import { Vector2 } from './vector.js'

export class Asteroid extends Entity {
  #hp = 1

  constructor(x, y, vel, radius = 28, rotationSpeed = 0.35) {
    super({
      pos: new Vector2(x, y),
      vel,
      radius,
      kind: 'asteroid',
    })
    this.rotationSpeed = rotationSpeed
  }

  get hp() {
    return this.#hp
  }

  takeDamage(amount) {
    this.#hp = Math.max(0, this.#hp - amount)
    if (this.#hp === 0) this.alive = false
    return !this.alive
  }

  update(dt) {
    this.angle += this.rotationSpeed * dt
    super.update(dt)
  }
}
