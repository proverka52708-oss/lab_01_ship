import { Entity } from './entity.ts'
import { Vector2 } from './vector.ts'

export type PickupEffect = 'shield' | 'rapid-fire' | 'repair'

export class Pickup extends Entity {
  effect: PickupEffect
  ttl: number

  constructor(x: number, y: number, effect: PickupEffect, lifetime = 20) {
    super({
      pos: new Vector2(x, y),
      radius: 14,
      kind: 'pickup',
    })
    this.effect = effect
    this.ttl = lifetime
  }

  update(dt: number): void {
    this.angle += dt
    this.ttl -= dt
    if (this.ttl <= 0) this.alive = false
  }
}
