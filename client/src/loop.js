const DEFAULT_STEP = 1 / 60
const MAX_FRAME_DELTA = 0.25

export function createLoop({ step = DEFAULT_STEP, simulate, render }) {
  let animationFrameId = null
  let running = false
  let accumulator = 0
  let lastTime = 0
  let frameCount = 0
  let stepCount = 0
  let statsTime = 0
  let framesPerSecond = 0
  let stepsPerSecond = 0
  let frameTime = 0

  function frame(now) {
    if (!running) return

    if (lastTime === 0) lastTime = now

    frameTime = now - lastTime
    lastTime = now
    accumulator += Math.min(frameTime / 1000, MAX_FRAME_DELTA)

    while (accumulator >= step) {
      simulate(step)
      accumulator -= step
      stepCount += 1
    }

    frameCount += 1
    if (now - statsTime >= 1000) {
      framesPerSecond = frameCount
      stepsPerSecond = stepCount
      frameCount = 0
      stepCount = 0
      statsTime = now
    }

    render(accumulator / step, {
      framesPerSecond,
      stepsPerSecond,
      frameTime,
    })

    animationFrameId = requestAnimationFrame(frame)
  }

  function start() {
    if (running) return

    running = true
    accumulator = 0
    lastTime = 0
    statsTime = performance.now()
    animationFrameId = requestAnimationFrame(frame)
  }

  function stop() {
    running = false
    if (animationFrameId !== null) cancelAnimationFrame(animationFrameId)
    animationFrameId = null
  }

  return { start, stop }
}
