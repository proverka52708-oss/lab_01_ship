import './style.css'
import { createInput } from './input.js'
import { createLoop } from './loop.js'
import { setupCanvas } from './render/canvas.js'
import { drawScene } from './render/draw.js'
import { wrapPosition } from './sim/arena.js'
import { copyShip, createShip, integrate } from './sim/ship.js'

const app = document.querySelector('#app')

app.innerHTML = `
  <main class="game-shell">
    <header class="game-header">
      <div>
        <p class="eyebrow">LAB 01 / EVENT LOOP</p>
        <h1>Star Runner</h1>
      </div>
      <p class="controls">W / A / D or arrow keys to fly</p>
    </header>
    <canvas id="gameCanvas" aria-label="Star Runner game area"></canvas>
  </main>
`

const canvas = document.querySelector('#gameCanvas')
const canvasView = setupCanvas(canvas)
const input = createInput(window)
const ship = createShip(0, 0)
let previousShip = copyShip(ship)

function resetShip() {
  ship.x = canvasView.width / 2
  ship.y = canvasView.height / 2
  ship.vx = 0
  ship.vy = 0
  ship.angle = -Math.PI / 2
  ship.thrust = false
  previousShip = copyShip(ship)
}

function simulate(step) {
  if (input.justPressed('KeyR')) resetShip()

  previousShip = copyShip(ship)
  integrate(ship, input, step)
  wrapPosition(ship, canvasView.width, canvasView.height)
  input.endFrame()
}

function render(alpha, stats) {
  drawScene(
    canvasView.context,
    canvasView.width,
    canvasView.height,
    previousShip,
    ship,
    alpha,
    stats,
  )
}

resetShip()

const loop = createLoop({
  simulate,
  render,
})

loop.start()
