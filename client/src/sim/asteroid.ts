import { Entity } from './entity.ts'
import { Vector2 } from './vector.ts'

export interface DamageableEntity extends Entity {}

export class Asteroid extends Entity {
  #hp = 1
  rotationSpeed: number

  constructor(x: number, y: number, vel: Vector2, radius = 28, rotationSpeed = 0.35) {
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

  takeDamage(amount: number): boolean {
    this.#hp = Math.max(0, this.#hp - amount)
    if (this.#hp === 0) this.alive = false
    return !this.alive
  }

  update(dt: number): void {
    this.angle += this.rotationSpeed * dt
    super.update(dt)
  }
}
