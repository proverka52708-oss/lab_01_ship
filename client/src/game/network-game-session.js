import { createInput } from '../input.js'
import { createLoop } from '../loop.js'
import { drawNetworkScene } from '../render/draw.js'
import { ClientNetcode } from '../netcode.js'

export function createNetworkGameSession({
  canvasView,
  assets,
  room,
  playerName,
  player,
  socketClient,
}) {
  const width = 960
  const height = 600
  const input = createInput(window)
  const netcode = new ClientNetcode({
    width,
    height,
    sendInput: (command) => socketClient.sendInput(command),
  })
  netcode.setIdentity(player)

  function simulate(dt) {
    netcode.step(dt, input)
    input.endFrame()
  }

  function render(alpha, stats) {
    const entities = netcode.renderEntities(performance.now())
    const world = {
      *ofKind(kind) {
        yield* entities.filter((entity) => entity.kind === kind)
      },
    }
    const ownShip = entities.find(
      (entity) => entity.id === netcode.localEntityId && entity.kind === 'ship',
    )
    const context = canvasView.context
    context.save()
    context.scale(canvasView.width / width, canvasView.height / height)
    drawNetworkScene(
      context,
      width,
      height,
      {
        ...stats,
        score: ownShip?.score ?? 0,
        hp: ownShip?.hp ?? 0,
        maxHp: 3,
        shieldTime: ownShip?.shield ? 1 : 0,
        rapidFireTime: 0,
        playerName,
        roomName: room.name,
      },
      world,
      assets.sprites.sheet,
      netcode.localEntityId,
    )
    context.restore()
  }

  const loop = createLoop({ simulate, render })

  return {
    netcode,
    start() {
      loop.start()
    },
    stop() {
      loop.stop()
      input.destroy()
    },
    receiveSnapshot(snapshot, receivedAt = performance.now()) {
      return netcode.receiveSnapshot(snapshot, receivedAt)
    },
    setIdentity(nextPlayer) {
      netcode.setIdentity(nextPlayer)
    },
  }
}
