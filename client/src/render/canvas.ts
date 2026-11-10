export function setupCanvas(canvas: HTMLCanvasElement): {
  context: CanvasRenderingContext2D
  readonly width: number
  readonly height: number
  destroy(): void
} {
  const context = canvas.getContext('2d')
  if (context === null) throw new Error('Canvas 2D context is unavailable')
  const drawingContext: CanvasRenderingContext2D = context
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
    drawingContext.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0)
  }

  window.addEventListener('resize', resize)
  resize()

  return {
    context: drawingContext,
    get width() {
      return width
    },
    get height() {
      return height
    },
    destroy: () => window.removeEventListener('resize', resize),
  }
}
