function lerp(start, end, alpha) {
  return start + (end - start) * alpha
}

function lerpAngle(start, end, alpha) {
  let difference = end - start
  while (difference > Math.PI) difference -= Math.PI * 2
  while (difference < -Math.PI) difference += Math.PI * 2
  return start + difference * alpha
}

function drawStars(context, width, height) {
  context.fillStyle = '#020817'
  context.fillRect(0, 0, width, height)
  context.fillStyle = 'rgba(186, 230, 253, 0.55)'

  for (let index = 0; index < 90; index += 1) {
    const x = (index * 97) % width
    const y = (index * 53) % height
    const size = index % 7 === 0 ? 2 : 1
    context.fillRect(x, y, size, size)
  }
}

export function drawShip(context, previous, current, alpha) {
  const ship = {
    x: lerp(previous.x, current.x, alpha),
    y: lerp(previous.y, current.y, alpha),
    angle: lerpAngle(previous.angle, current.angle, alpha),
    thrust: current.thrust,
  }

  context.save()
  context.translate(ship.x, ship.y)
  context.rotate(ship.angle)

  if (ship.thrust) {
    context.beginPath()
    context.moveTo(-16, 0)
    context.lineTo(-30, 7)
    context.lineTo(-25, 0)
    context.lineTo(-30, -7)
    context.closePath()
    context.fillStyle = '#fb923c'
    context.fill()
  }

  context.beginPath()
  context.moveTo(24, 0)
  context.lineTo(-16, 13)
  context.lineTo(-8, 0)
  context.lineTo(-16, -13)
  context.closePath()
  context.fillStyle = '#38bdf8'
  context.fill()
  context.strokeStyle = '#e0f2fe'
  context.lineWidth = 2
  context.stroke()

  context.restore()
}

export function drawHud(context, stats) {
  context.fillStyle = 'rgba(2, 8, 23, 0.78)'
  context.fillRect(16, 16, 190, 86)
  context.fillStyle = '#e0f2fe'
  context.font = '14px Consolas, monospace'
  context.fillText(`steps/s: ${stats.stepsPerSecond}`, 28, 40)
  context.fillText(`frames/s: ${stats.framesPerSecond}`, 28, 62)
  context.fillText(`frame: ${stats.frameTime.toFixed(2)} ms`, 28, 84)
}

export function drawScene(context, width, height, previous, current, alpha, stats) {
  drawStars(context, width, height)
  drawShip(context, previous, current, alpha)
  drawHud(context, stats)
}
