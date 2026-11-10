import { createInput } from '../input.ts'
import { createLoop } from '../loop.ts'
import { drawScene } from '../render/draw.ts'
import { bounceAtBounds, wrapPosition } from '../sim/arena.ts'
import { Asteroid } from '../sim/asteroid.ts'
import { resolveCollisions } from '../sim/collision.ts'
import { copyShip, createShip } from '../sim/ship.ts'
import { Vector2 } from '../sim/vector.ts'
import { World } from '../sim/world.ts'
import { Explosion } from '../sim/explosion.ts'
import { Pickup } from '../sim/pickup.ts'
import { createHomingBehavior } from '../sim/homing.ts'
import type { GameEvents } from '../audio/game-events.ts'
import type { LoadedAssets } from '../assets/loader.ts'
import type { LobbyRoom } from '../lobby/lobby.ts'
import type { FrameStats } from '../loop.ts'
import type { setupCanvas } from '../render/canvas.ts'

interface GameAssets extends LoadedAssets {
  sprites: LoadedAssets['sprites'] & { sheet?: HTMLImageElement }
}

interface GameSessionOptions {
  canvasView: ReturnType<typeof setupCanvas>
  assets: GameAssets
  events: GameEvents
  room: LobbyRoom
  playerName: string
}

export function createGameSession({
  canvasView,
  assets,
  events,
  room,
  playerName,
}: GameSessionOptions): { start(): void; stop(): void } {
  const world = new World()
  const input = createInput(window)
  const ship = createShip(0, 0)
  const arena = room.arena ?? assets.data.arena ?? {}
  const gameWidth = arena.width ?? canvasView.width
  const gameHeight = arena.height ?? canvasView.height
  let score = 0
  let respawnTimer: number | null = null
  let previousShip = copyShip(ship)

  world.spawn(ship)

  function spawnAsteroids() {
    const count = Math.max(1, Math.min(8, arena.asteroidCount ?? 3))
    for (let index = 0; index < count; index += 1) {
      const angle = (index / count) * Math.PI * 2
      const radius = 22 + (index % 3) * 7
      const asteroid = new Asteroid(
        gameWidth * (0.2 + ((index * 0.31) % 0.65)),
        gameHeight * (0.2 + ((index * 0.47) % 0.65)),
        new Vector2(Math.cos(angle) * 28, Math.sin(angle) * 25),
        radius,
        index % 2 === 0 ? 0.3 : -0.24,
      )
      if (index === 0) asteroid.addBehavior(createHomingBehavior(() => ship, 0.28, 36))
      world.spawn(asteroid)
    }

    world.spawn(new Pickup(gameWidth * 0.5, gameHeight * 0.2, 'shield'))
    world.spawn(new Pickup(gameWidth * 0.5, gameHeight * 0.8, 'rapid-fire'))
  }

  function resetRound() {
    ship.reset(gameWidth / 2, gameHeight / 2)
    for (const entity of world) {
      if (entity !== ship) world.despawn(entity.id)
    }
    score = 0
    respawnTimer = null
    spawnAsteroids()
    previousShip = copyShip(ship)
  }

  function findSafeSpawn() {
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const position = new Vector2(
        40 + Math.random() * Math.max(1, gameWidth - 80),
        40 + Math.random() * Math.max(1, gameHeight - 80),
      )
      const safe = [...world.ofKind('asteroid')].every(
        (asteroid) =>
          position.sub(asteroid.pos).length() > asteroid.radius + ship.radius + 50,
      )
      if (safe) return position
    }
    return new Vector2(gameWidth / 2, gameHeight / 2)
  }

  function simulate(dt: number): void {
    if (input.justPressed('KeyR')) resetRound()
    previousShip = copyShip(ship)
    world.step(dt, input)

    for (const event of resolveCollisions(world)) {
      if (event.type === 'asteroid-hit') events.emit('hit', { entity: 'asteroid' })
      if (event.type === 'asteroid-destroyed') {
        score += 100
        events.emit('exploded', { entity: 'asteroid' })
        world.spawn(new Explosion(event.asteroid.pos, event.asteroid.radius))
      }
      if (event.type === 'ship-hit') {
        events.emit('hit', { entity: 'ship' })
        world.spawn(new Explosion(event.ship.pos, 14, 0.25))
      }
      if (event.type === 'ship-destroyed') {
        events.emit('exploded', { entity: 'ship' })
        world.spawn(new Explosion(event.ship.pos, 36, 0.7))
        respawnTimer = 2
      }
      if (event.type === 'pickup-collected') {
        score += 25
        events.emit('pickup', { effect: event.pickup.effect })
      }
    }

    if ((input.isDown('Space') || input.justPressed('Space')) && !ship.destroyed) {
      const target = [...world.ofKind('asteroid')].sort(
        (first, second) =>
          first.pos.sub(ship.pos).length() - second.pos.sub(ship.pos).length(),
      )[0]
      const bullet = ship.fire(target)
      if (bullet) {
        world.spawn(bullet)
        events.emit('fired', { position: ship.pos })
      }
    }

    if (ship.destroyed && respawnTimer !== null) {
      respawnTimer -= dt
      if (respawnTimer <= 0) {
        const safePosition = findSafeSpawn()
        ship.reset(safePosition.x, safePosition.y)
        respawnTimer = null
      }
    }

    wrapPosition(ship, gameWidth, gameHeight)
    for (const asteroid of world.ofKind('asteroid')) {
      bounceAtBounds(asteroid, gameWidth, gameHeight)
    }
    input.endFrame()
  }

  function render(alpha: number, stats: FrameStats): void {
    const context = canvasView.context
    context.save()
    context.scale(canvasView.width / gameWidth, canvasView.height / gameHeight)
    drawScene(
      context,
      gameWidth,
      gameHeight,
      previousShip,
      copyShip(ship),
      alpha,
      {
        ...stats,
        score,
        hp: ship.hp,
        shieldTime: ship.shieldTime,
        rapidFireTime: ship.rapidFireTime,
        playerName,
        roomName: room.name,
      },
      world,
      assets.sprites.sheet,
    )
    context.restore()
  }

  resetRound()
  const loop = createLoop({ simulate, render })

  return {
    start() {
      loop.start()
    },
    stop() {
      loop.stop()
      input.destroy()
    },
  }
}
