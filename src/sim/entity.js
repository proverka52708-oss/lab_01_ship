import { Vector2 } from './vector.js'

export class Entity {
  static #nextId = 1
  #id = Entity.#nextId++

  constructor({
    pos = new Vector2(),
    vel = new Vector2(),
    angle = 0,
    radius = 10,
    kind = 'entity',
  } = {}) {
    this.pos = pos
    this.vel = vel
    this.angle = angle
    this.radius = radius
    this.alive = true
    this.kind = kind
    this.behaviors = new Set()
  }

  get id() {
    return this.#id
  }

  addBehavior(behavior) {
    this.behaviors.add(behavior)
    return this
  }

  update(dt) {
    for (const behavior of this.behaviors) behavior.update(this, dt)
    this.pos = this.pos.add(this.vel.scale(dt))
  }
}
