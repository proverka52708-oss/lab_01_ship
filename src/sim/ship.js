import { Entity } from './entity.js'
import { Vector2 } from './vector.js'
import { Bullet } from './bullet.js'

const ROTATION_SPEED = 3.2
const THRUST_POWER = 220
const DRAG = 0.985
const MAX_SPEED = 360
const BULLET_SPEED = 420

export class Ship extends Entity {
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

  reset(x, y) {
    this.pos = new Vector2(x, y)
    this.vel = new Vector2()
    this.angle = -Math.PI / 2
    this.thrust = false
    this.alive = true
  }

  fire() {
    const direction = Vector2.fromAngle(this.angle)
    const position = this.pos.add(direction.scale(this.radius + 5))
    const velocity = this.vel.add(direction.scale(BULLET_SPEED))
    return new Bullet(position, velocity)
  }

  update(dt, input) {
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
  }
}
