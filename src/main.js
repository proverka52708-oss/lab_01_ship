import './style.css'
import { createInput } from './input.js'
import { createLoop } from './loop.js'
import { setupCanvas } from './render/canvas.js'
import { drawScene } from './render/draw.js'
import { bounceAtBounds, wrapPosition } from './sim/arena.js'
import { Asteroid } from './sim/asteroid.js'
import { resolveCollisions } from './sim/collision.js'
import { copyShip, createShip } from './sim/ship.js'
import { Vector2 } from './sim/vector.js'
import { World } from './sim/world.js'
import { createHomingBehavior } from './sim/homing.js'
import { Explosion } from './sim/explosion.js'
import { Pickup } from './sim/pickup.js'

const app = document.querySelector('#app')

app.innerHTML = `
  <main class="game-shell">
    <header class="game-header">
      <div>
        <p class="eyebrow">LAB 02 / ENTITY MODEL</p>
        <h1>Star Runner</h1>
      </div>
      <p class="controls">W/A/D or arrows: fly · Space: shoot · collect pickups · R: restart</p>
    </header>
    <canvas id="gameCanvas" aria-label="Star Runner game area"></canvas>
  </main>
`

const canvas = document.querySelector('#gameCanvas')
const canvasView = setupCanvas(canvas)
const input = createInput(window)
const world = new World()
const ship = createShip(0, 0)
world.spawn(ship)
let previousShip = copyShip(ship)
let score = 0
let respawnTimer = null

function spawnAsteroids() {
  const firstAsteroid = new Asteroid(
    canvasView.width * 0.25,
    canvasView.height * 0.3,
    new Vector2(34, 22),
  )
  firstAsteroid.addBehavior(createHomingBehavior(() => ship, 0.32, 38))
  world.spawn(firstAsteroid)
  world.spawn(
    new Asteroid(
      canvasView.width * 0.72,
      canvasView.height * 0.26,
      new Vector2(-26, 31),
      36,
    ),
  )
  world.spawn(
    new Asteroid(
      canvasView.width * 0.68,
      canvasView.height * 0.73,
      new Vector2(-32, -24),
      24,
      -0.25,
    ),
  )
  world.spawn(new Pickup(canvasView.width * 0.5, canvasView.height * 0.18, 'shield'))
  world.spawn(new Pickup(canvasView.width * 0.5, canvasView.height * 0.82, 'rapid-fire'))
}

function resetRound() {
  ship.reset(canvasView.width / 2, canvasView.height / 2)

  for (const entity of world) {
    if (entity !== ship) world.despawn(entity.id)
  }

  spawnAsteroids()
  score = 0
  respawnTimer = null
  previousShip = copyShip(ship)
}

function findSafeSpawn() {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const position = new Vector2(
      40 + Math.random() * Math.max(1, canvasView.width - 80),
      40 + Math.random() * Math.max(1, canvasView.height - 80),
    )
    const isSafe = [...world.ofKind('asteroid')].every((asteroid) => {
      const distance = position.sub(asteroid.pos).length()
      return distance > asteroid.radius + ship.radius + 50
    })
    if (isSafe) return position
  }

  return new Vector2(canvasView.width / 2, canvasView.height / 2)
}

function simulate(step) {
  if (input.justPressed('KeyR')) resetRound()

  previousShip = copyShip(ship)
  world.step(step, input)

  for (const event of resolveCollisions(world)) {
    if (event.type === 'asteroid-destroyed') {
      score += 100
      world.spawn(new Explosion(event.asteroid.pos, event.asteroid.radius))
    }
    if (event.type === 'ship-hit') {
      world.spawn(new Explosion(event.ship.pos, 14, 0.25))
    }
    if (event.type === 'ship-destroyed') {
      world.spawn(new Explosion(event.ship.pos, 36, 0.7))
      respawnTimer = 2
    }
    if (event.type === 'pickup-collected') score += 25
  }

  if ((input.isDown('Space') || input.justPressed('Space')) && !ship.destroyed) {
    const target = [...world.ofKind('asteroid')].sort(
      (first, second) =>
        first.pos.sub(ship.pos).length() - second.pos.sub(ship.pos).length(),
    )[0]
    const bullet = ship.fire(target)
    if (bullet) world.spawn(bullet)
  }

  if (ship.destroyed && respawnTimer !== null) {
    respawnTimer -= step
    if (respawnTimer <= 0) {
      const position = findSafeSpawn()
      ship.reset(position.x, position.y)
      respawnTimer = null
    }
  }

  wrapPosition(ship, canvasView.width, canvasView.height)
  for (const asteroid of world.ofKind('asteroid')) {
    bounceAtBounds(asteroid, canvasView.width, canvasView.height)
  }
  input.endFrame()
}

function render(alpha, stats) {
  drawScene(
    canvasView.context,
    canvasView.width,
    canvasView.height,
    previousShip,
    copyShip(ship),
    alpha,
    {
      ...stats,
      score,
      hp: ship.hp,
      shieldTime: ship.shieldTime,
      rapidFireTime: ship.rapidFireTime,
    },
    world,
  )
}

resetRound()

const loop = createLoop({
  simulate,
  render,
})

loop.start()
