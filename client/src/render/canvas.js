export function setupCanvas(canvas) {
  const context = canvas.getContext('2d')
  let width = 0
  let height = 0
  let devicePixelRatio = 1

  function resize() {
    const bounds = canvas.getBoundingClientRect()
    width = bounds.width
    height = bounds.height
    devicePixelRatio = window.devicePixelRatio || 1

    canvas.width = Math.round(width * devicePixelRatio)
    canvas.height = Math.round(height * devicePixelRatio)
    context.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0)
  }

  window.addEventListener('resize', resize)
  resize()

  return {
    context,
    get width() {
      return width
    },
    get height() {
      return height
    },
    destroy: () => window.removeEventListener('resize', resize),
  }
}
