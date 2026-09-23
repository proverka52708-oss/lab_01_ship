const ROTATION_SPEED = 3.2
const THRUST_POWER = 220
const DRAG = 0.985
const MAX_SPEED = 360

export function createShip(x, y) {
  return {
    x,
    y,
    vx: 0,
    vy: 0,
    angle: -Math.PI / 2,
    thrust: false,
  }
}

export function copyShip(ship) {
  return { ...ship }
}

export function integrate(ship, input, dt) {
  const left = input.isDown('ArrowLeft') || input.isDown('KeyA')
  const right = input.isDown('ArrowRight') || input.isDown('KeyD')
  const thrusting = input.isDown('ArrowUp') || input.isDown('KeyW')

  if (left) ship.angle -= ROTATION_SPEED * dt
  if (right) ship.angle += ROTATION_SPEED * dt

  ship.thrust = thrusting
  if (thrusting) {
    ship.vx += Math.cos(ship.angle) * THRUST_POWER * dt
    ship.vy += Math.sin(ship.angle) * THRUST_POWER * dt
  }

  const drag = Math.pow(DRAG, dt * 60)
  ship.vx *= drag
  ship.vy *= drag

  const speed = Math.hypot(ship.vx, ship.vy)
  if (speed > MAX_SPEED) {
    const scale = MAX_SPEED / speed
    ship.vx *= scale
    ship.vy *= scale
  }

  ship.x += ship.vx * dt
  ship.y += ship.vy * dt
}
