import { Vector2 } from './vector.ts'

export interface Behavior {
  update(entity: Entity, dt: number): void
}

export interface InputState {
  isDown(code: string): boolean
}

export interface EntityOptions {
  pos?: Vector2
  vel?: Vector2
  angle?: number
  radius?: number
  kind?: string
}

export class Entity {
  static #nextId = 1
  #id = Entity.#nextId++
  pos: Vector2
  vel: Vector2
  angle: number
  radius: number
  alive: boolean
  kind: string
  behaviors: Set<Behavior>

  constructor({
    pos = new Vector2(),
    vel = new Vector2(),
    angle = 0,
    radius = 10,
    kind = 'entity',
  }: EntityOptions = {}) {
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

  addBehavior(behavior: Behavior): this {
    this.behaviors.add(behavior)
    return this
  }

  update(dt: number, _inputs?: InputState): void {
    for (const behavior of this.behaviors) behavior.update(this, dt)
    this.pos = this.pos.add(this.vel.scale(dt))
  }
}
