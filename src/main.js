import './style.css'
import { createInput } from './input.js'
import { createLoop } from './loop.js'
import { setupCanvas } from './render/canvas.js'
import { drawScene } from './render/draw.js'
import { bounceAtBounds, wrapPosition } from './sim/arena.js'
import { Asteroid } from './sim/asteroid.js'
import { resolveBulletAsteroidCollisions } from './sim/collision.js'
import { copyShip, createShip } from './sim/ship.js'
import { Vector2 } from './sim/vector.js'
import { World } from './sim/world.js'

const app = document.querySelector('#app')

app.innerHTML = `
  <main class="game-shell">
    <header class="game-header">
      <div>
        <p class="eyebrow">LAB 01 / EVENT LOOP</p>
        <h1>Star Runner</h1>
      </div>
      <p class="controls">W / A / D or arrows to fly / Space to shoot / R to reset</p>
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

function spawnAsteroids() {
  world.spawn(
    new Asteroid(canvasView.width * 0.25, canvasView.height * 0.3, new Vector2(34, 22)),
  )
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
}

function resetRound() {
  ship.reset(canvasView.width / 2, canvasView.height / 2)

  for (const entity of world) {
    if (entity !== ship) world.despawn(entity.id)
  }

  spawnAsteroids()
  previousShip = copyShip(ship)
}

function simulate(step) {
  if (input.justPressed('KeyR')) resetRound()
  if (input.justPressed('Space')) world.spawn(ship.fire())

  previousShip = copyShip(ship)
  world.step(step, input)
  resolveBulletAsteroidCollisions(world)
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
    stats,
    world,
  )
}

resetRound()

const loop = createLoop({
  simulate,
  render,
})

loop.start()
