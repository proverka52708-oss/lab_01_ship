import { createInput } from '../input.ts'
import { createLoop } from '../loop.ts'
import { drawNetworkScene } from '../render/draw.ts'
import { ClientNetcode } from '../netcode.ts'
import type { LoadedAssets } from '../assets/loader.ts'
import type { LobbyRoom } from '../lobby/lobby.ts'
import type { FrameStats } from '../loop.ts'
import type { setupCanvas } from '../render/canvas.ts'
import type { SnapshotMessage, PlayerIdentity, SocketClient } from '../net/socket-client.ts'

interface GameAssets extends LoadedAssets {
  sprites: LoadedAssets['sprites'] & { sheet?: HTMLImageElement }
}

interface NetworkGameSessionOptions {
  canvasView: ReturnType<typeof setupCanvas>
  assets: GameAssets
  room: LobbyRoom
  playerName: string
  player: PlayerIdentity
  socketClient: SocketClient
}

export function createNetworkGameSession({
  canvasView,
  assets,
  room,
  playerName,
  player,
  socketClient,
}: NetworkGameSessionOptions) {
  const width = 960
  const height = 600
  const input = createInput(window)
  const netcode = new ClientNetcode({
    width,
    height,
    sendInput: (command) => socketClient.sendInput(command),
  })
  netcode.setIdentity(player)

  function simulate(dt: number): void {
    netcode.step(dt, input)
    input.endFrame()
  }

  function render(_alpha: number, stats: FrameStats): void {
    const entities = netcode.renderEntities(performance.now())
    const world = {
      *ofKind(kind: string) {
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
    receiveSnapshot(snapshot: SnapshotMessage, receivedAt = performance.now()): boolean {
      return netcode.receiveSnapshot(snapshot, receivedAt)
    },
    setIdentity(nextPlayer: PlayerIdentity): void {
      netcode.setIdentity(nextPlayer)
    },
  }
}
