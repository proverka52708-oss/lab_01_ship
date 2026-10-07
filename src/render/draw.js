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
  if (current.destroyed) return

  const ship = {
    x: lerp(previous.x, current.x, alpha),
    y: lerp(previous.y, current.y, alpha),
    angle: lerpAngle(previous.angle, current.angle, alpha),
    thrust: current.thrust,
  }

  context.save()
  context.translate(ship.x, ship.y)
  context.rotate(ship.angle)
  if (current.invulnerable) context.globalAlpha = 0.55

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

function drawBullets(context, world) {
  for (const bullet of world.ofKind('bullet')) {
    context.beginPath()
    context.arc(bullet.pos.x, bullet.pos.y, bullet.radius, 0, Math.PI * 2)
    context.fillStyle = '#fcd34d'
    context.fill()
  }
}

function drawAsteroids(context, world) {
  for (const asteroid of world.ofKind('asteroid')) {
    context.save()
    context.translate(asteroid.pos.x, asteroid.pos.y)
    context.rotate(asteroid.angle)
    context.beginPath()

    for (let index = 0; index < 10; index += 1) {
      const angle = (index / 10) * Math.PI * 2
      const variation = index % 2 === 0 ? 0.9 : 1.08
      const x = Math.cos(angle) * asteroid.radius * variation
      const y = Math.sin(angle) * asteroid.radius * variation

      if (index === 0) context.moveTo(x, y)
      else context.lineTo(x, y)
    }

    context.closePath()
    context.fillStyle = '#334155'
    context.strokeStyle = '#94a3b8'
    context.lineWidth = 2
    context.fill()
    context.stroke()
    context.restore()
  }
}

function drawPickups(context, world) {
  for (const pickup of world.ofKind('pickup')) {
    context.save()
    context.translate(pickup.pos.x, pickup.pos.y)
    context.rotate(pickup.angle)
    context.strokeStyle = pickup.effect === 'shield' ? '#67e8f9' : '#fbbf24'
    context.fillStyle = 'rgba(15, 23, 42, 0.9)'
    context.lineWidth = 3
    context.beginPath()
    context.arc(0, 0, pickup.radius, 0, Math.PI * 2)
    context.fill()
    context.stroke()
    context.fillStyle = context.strokeStyle
    context.font = 'bold 16px Consolas, monospace'
    context.textAlign = 'center'
    context.textBaseline = 'middle'
    context.fillText(pickup.effect === 'shield' ? 'S' : 'F', 0, 1)
    context.restore()
  }
}

function drawExplosions(context, world) {
  for (const explosion of world.ofKind('explosion')) {
    const progress = explosion.progress
    context.save()
    context.globalAlpha = 1 - progress
    context.strokeStyle = '#fb923c'
    context.lineWidth = 3

    for (let index = 0; index < 8; index += 1) {
      const angle = (index / 8) * Math.PI * 2
      const inner = explosion.radius * progress * 0.45
      const outer = explosion.radius * (0.35 + progress * 0.65)
      context.beginPath()
      context.moveTo(
        explosion.pos.x + Math.cos(angle) * inner,
        explosion.pos.y + Math.sin(angle) * inner,
      )
      context.lineTo(
        explosion.pos.x + Math.cos(angle) * outer,
        explosion.pos.y + Math.sin(angle) * outer,
      )
      context.stroke()
    }

    context.restore()
  }
}

export function drawHud(context, stats) {
  context.fillStyle = 'rgba(2, 8, 23, 0.78)'
  context.fillRect(16, 16, 220, 190)
  context.fillStyle = '#e0f2fe'
  context.font = '14px Consolas, monospace'
  context.fillText(`steps/s: ${stats.stepsPerSecond}`, 28, 40)
  context.fillText(`frames/s: ${stats.framesPerSecond}`, 28, 62)
  context.fillText(`frame: ${stats.frameTime.toFixed(2)} ms`, 28, 84)
  context.fillText(`score: ${stats.score}`, 28, 106)
  context.fillText(`hull: ${stats.hp}/100`, 28, 128)
  if (stats.shieldTime > 0) {
    context.fillText(`shield: ${stats.shieldTime.toFixed(1)}s`, 28, 150)
  }
  if (stats.rapidFireTime > 0) {
    context.fillText(`rapid: ${stats.rapidFireTime.toFixed(1)}s`, 28, 172)
  }
}

export function drawScene(
  context,
  width,
  height,
  previous,
  current,
  alpha,
  stats,
  world,
) {
  drawStars(context, width, height)
  drawAsteroids(context, world)
  drawPickups(context, world)
  drawBullets(context, world)
  drawExplosions(context, world)
  drawShip(context, previous, current, alpha)
  drawHud(context, stats)
}
