import { Entity } from './entity.js'
import { Vector2 } from './vector.js'
import { Bullet } from './bullet.js'
import { createHomingBehavior } from './homing.js'

const ROTATION_SPEED = 3.2
const THRUST_POWER = 220
const DRAG = 0.985
const MAX_SPEED = 360
const BULLET_SPEED = 420

export class Ship extends Entity {
  #hp = 100
  #invulnerability = 0
  #shieldTime = 0
  #rapidFireTime = 0
  #fireCooldown = 0

  constructor(x = 0, y = 0) {
    super({
      pos: new Vector2(x, y),
      vel: new Vector2(),
      angle: -Math.PI / 2,
      radius: 20,
      kind: 'ship',
    })
    this.thrust = false
  }

  get hp() {
    return this.#hp
  }

  get destroyed() {
    return this.#hp <= 0
  }

  get shieldTime() {
    return this.#shieldTime
  }

  get rapidFireTime() {
    return this.#rapidFireTime
  }

  get invulnerable() {
    return this.#invulnerability > 0 || this.#shieldTime > 0
  }

  reset(x, y) {
    this.pos = new Vector2(x, y)
    this.vel = new Vector2()
    this.angle = -Math.PI / 2
    this.thrust = false
    this.alive = true
    this.#hp = 100
    this.#invulnerability = 1.5
    this.#shieldTime = 0
    this.#rapidFireTime = 0
    this.#fireCooldown = 0
  }

  takeDamage(amount) {
    if (this.destroyed || this.invulnerable) return false

    this.#hp = Math.max(0, this.#hp - amount)
    if (this.destroyed) {
      this.vel = new Vector2()
      this.thrust = false
    } else {
      this.#invulnerability = 0.8
    }

    return this.destroyed
  }

  activatePickup(effect, duration = 6) {
    if (effect === 'shield') this.#shieldTime = duration
    if (effect === 'rapid-fire') this.#rapidFireTime = duration
  }

  fire(target = null) {
    if (this.destroyed || this.#fireCooldown > 0) return null

    const direction = Vector2.fromAngle(this.angle)
    const position = this.pos.add(direction.scale(this.radius + 5))
    const velocity = this.vel.add(direction.scale(BULLET_SPEED))
    this.#fireCooldown = this.#rapidFireTime > 0 ? 0.09 : 0.24

    const bullet = new Bullet(position, velocity)
    if (target) bullet.addBehavior(createHomingBehavior(() => target, 5, BULLET_SPEED))
    return bullet
  }

  update(dt, input) {
    this.#invulnerability = Math.max(0, this.#invulnerability - dt)
    this.#shieldTime = Math.max(0, this.#shieldTime - dt)
    this.#rapidFireTime = Math.max(0, this.#rapidFireTime - dt)
    this.#fireCooldown = Math.max(0, this.#fireCooldown - dt)

    if (this.destroyed) {
      this.thrust = false
      return
    }

    const left = input.isDown('ArrowLeft') || input.isDown('KeyA')
    const right = input.isDown('ArrowRight') || input.isDown('KeyD')
    const thrusting = input.isDown('ArrowUp') || input.isDown('KeyW')

    if (left) this.angle -= ROTATION_SPEED * dt
    if (right) this.angle += ROTATION_SPEED * dt

    this.thrust = thrusting
    if (thrusting) {
      this.vel = this.vel.add(Vector2.fromAngle(this.angle, THRUST_POWER * dt))
    }

    const drag = Math.pow(DRAG, dt * 60)
    this.vel = this.vel.scale(drag)

    const speed = this.vel.length()
    if (speed > MAX_SPEED) {
      this.vel = this.vel.scale(MAX_SPEED / speed)
    }

    super.update(dt)
  }
}

export function createShip(x, y) {
  return new Ship(x, y)
}

export function copyShip(ship) {
  return {
    x: ship.pos.x,
    y: ship.pos.y,
    angle: ship.angle,
    thrust: ship.thrust,
    destroyed: ship.destroyed,
    invulnerable: ship.invulnerable,
  }
}
