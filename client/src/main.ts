import './style.css'
import { setupCanvas } from './render/canvas.ts'
import { drawLoading } from './render/draw.ts'
import {
  loadAll,
  loadJson,
  parseAssetManifest,
  withRetry,
  type AssetFailure,
  type LoadProgress,
  type LoadedAssets,
} from './assets/loader.ts'
import { runFailureGallery, compareLoadingTimes } from './assets/failure-gallery.ts'
import { Lobby, type LobbyRoom } from './lobby/lobby.ts'
import { mountLobbyView } from './lobby/view.ts'
import { GameEvents } from './audio/game-events.ts'
import { createAudioPlayer } from './audio/audio-player.ts'
import { SocketClient, type Codec, type PlayerIdentity } from './net/socket-client.ts'
import { NetworkEmulator } from './network-emulator.ts'
import { createNetworkGameSession } from './game/network-game-session.ts'
import { decodeBinary, encodeBinary } from '@dogfight/shared/codec'
import { parseServerMessage } from './net/socket-client.ts'

function getElement(selector: string): HTMLElement {
  const element = document.querySelector(selector)
  if (!element) throw new Error(`Required page element is missing: ${selector}`)
  if (!(element instanceof HTMLElement)) {
    throw new TypeError(`Page element is not an HTML element: ${selector}`)
  }
  return element
}

function getValueElement(
  selector: string,
): HTMLInputElement | HTMLSelectElement | HTMLOutputElement {
  const element = getElement(selector)
  if (
    element instanceof HTMLInputElement ||
    element instanceof HTMLSelectElement ||
    element instanceof HTMLOutputElement
  ) {
    return element
  }
  throw new TypeError(`Page element does not have a value: ${selector}`)
}

function unreachable(value: never): never {
  throw new Error(`Unexpected server message: ${String(value)}`)
}

function parseCodec(value: string): Codec {
  if (value === 'json' || value === 'binary') return value
  throw new TypeError('Unsupported network codec')
}

const app = getElement('#app')
app.innerHTML = `
  <main class="game-shell">
    <header class="game-header">
      <div>
        <p class="eyebrow">LAB 04 / REAL-TIME MULTIPLAYER</p>
        <h1>Star Runner</h1>
      </div>
      <p class="controls">Assets load concurrently · lobby requests cancel on leave</p>
    </header>
    <div class="game-stage">
      <canvas id="gameCanvas" aria-label="Star Runner game area"></canvas>
      <div id="stageOverlay" class="stage-overlay" aria-live="polite"></div>
      <div id="stageTools" class="stage-tools"></div>
    </div>
    <div id="lobbyRoot"></div>
    <section class="network-panel" aria-label="Room chat">
      <div class="network-heading">
        <h2>Room chat</h2>
        <span id="socketStatus" class="status-light">offline</span>
      </div>
      <p id="networkNotice" class="network-notice">Join a room to chat with other pilots.</p>
      <ol id="chatMessages" class="chat-messages" aria-live="polite"></ol>
      <form id="chatForm" class="chat-form">
        <label class="visually-hidden" for="chatInput">Chat message</label>
        <input id="chatInput" name="message" maxlength="300" autocomplete="off" placeholder="Type a message..." required />
        <button type="submit">Send</button>
      </form>
      <details class="network-tools">
        <summary>Network experiments</summary>
        <label>Codec
          <select id="networkCodec">
            <option value="json">JSON</option>
            <option value="binary">Binary DataView</option>
          </select>
        </label>
        <label>Delay <input id="networkDelay" type="range" min="0" max="300" step="10" value="0" /><output id="networkDelayValue">0 ms</output></label>
        <label>Jitter <input id="networkJitter" type="range" min="0" max="120" step="5" value="0" /><output id="networkJitterValue">0 ms</output></label>
        <label>Loss <input id="networkLoss" type="range" min="0" max="30" step="1" value="0" /><output id="networkLossValue">0%</output></label>
        <label>Interpolation <input id="interpolationDelay" type="range" min="0" max="300" step="10" value="100" /><output id="interpolationValue">100 ms</output></label>
        <p id="netgraph" aria-live="polite">RTT: -- · Snapshot age: -- · Pending input: 0 · Correction: 0 px</p>
        <button id="measureCodecs" type="button">Compare JSON and binary</button>
        <pre id="codecMeasurement" aria-live="polite"></pre>
      </details>
    </section>
  </main>
`

const canvasElement = getElement('#gameCanvas')
if (!(canvasElement instanceof HTMLCanvasElement)) {
  throw new TypeError('Game canvas element is invalid')
}
const canvas = canvasElement
const canvasView = setupCanvas(canvas)
const overlay = getElement('#stageOverlay')
const tools = getElement('#stageTools')
const lobbyRoot = getElement('#lobbyRoot')
let audioContext: AudioContext | null = null
let audioPlayer: ReturnType<typeof createAudioPlayer> | null = null
let currentGame: ReturnType<typeof createNetworkGameSession> | null = null
let lobby: Lobby | null = null
let lobbyView: ReturnType<typeof mountLobbyView> | null = null
let loadedResources: LoadedAssets | null = null
let loadingController: AbortController | null = null
let socketClient: SocketClient | null = null
let botWorker: Worker | null = null
const networkEmulator = new NetworkEmulator()
let netgraphTimer: ReturnType<typeof setInterval> | null = null

function setupSocketClient() {
  if (socketClient) return
  const client = new SocketClient()
  socketClient = client
  client.setNetworkEmulator(networkEmulator)
  client.addEventListener('status', (event) => {
    if (!(event instanceof CustomEvent) || typeof event.detail !== 'string') return
    const detail = event.detail
    const status = getElement('#socketStatus')
    status.textContent = detail
    status.classList.toggle('is-ready', detail === 'connected')
  })
  client.addEventListener('message', (event) => {
    if (!(event instanceof CustomEvent)) return
    const message = parseServerMessage(event.detail)
    const notice = getElement('#networkNotice')
    switch (message.type) {
      case 'joined':
        notice.textContent = `Joined ${message.room.name} as ${message.player.name}`
        currentGame?.setIdentity(message.player)
        break
      case 'snapshot':
        currentGame?.receiveSnapshot(message)
        break
      case 'player-joined':
        notice.textContent = `${message.player.name} joined the room`
        break
      case 'player-left':
        notice.textContent = `${message.player.name} left the room`
        break
      case 'chat': {
        const messages = getElement('#chatMessages')
        const item = document.createElement('li')
        item.textContent = `${message.player}: ${message.text}`
        messages.append(item)
        messages.scrollTop = messages.scrollHeight
        break
      }
      case 'server-error':
        notice.textContent = message.message
        break
      case 'pong':
        break
      default:
        unreachable(message)
    }
  })
  client.addEventListener('close', () => {
    getElement('#networkNotice').textContent =
      'Connection lost. Reconnecting and restoring your room...'
  })
  client.addEventListener('socket-error', (event) => {
    if (event instanceof CustomEvent && typeof event.detail === 'string') {
      getElement('#networkNotice').textContent = event.detail
    }
  })
  const configureNetwork = () => {
    networkEmulator.configure({
      delayMs: Number(getValueElement('#networkDelay').value),
      jitterMs: Number(getValueElement('#networkJitter').value),
      lossPercent: Number(getValueElement('#networkLoss').value),
    })
    const netcode = currentGame?.netcode
    netcode?.setInterpolationDelay(Number(getValueElement('#interpolationDelay').value))
    getValueElement('#networkDelayValue').value = `${getValueElement('#networkDelay').value} ms`
    getValueElement('#networkJitterValue').value = `${getValueElement('#networkJitter').value} ms`
    getValueElement('#networkLossValue').value = `${getValueElement('#networkLoss').value}%`
    getValueElement('#interpolationValue').value = `${getValueElement('#interpolationDelay').value} ms`
  }
  for (const id of ['networkDelay', 'networkJitter', 'networkLoss', 'interpolationDelay']) {
    getElement(`#${id}`).addEventListener('input', configureNetwork)
  }
  configureNetwork()
  getElement('#measureCodecs').addEventListener('click', measureCodecs)
  getElement('#chatForm').addEventListener('submit', (event) => {
    event.preventDefault()
    const input = getValueElement('#chatInput')
    try {
      client.send({ type: 'chat', text: input.value })
      input.value = ''
    } catch (error) {
      getElement('#networkNotice').textContent = error instanceof Error ? error.message : 'Unable to send message'
    }
  })
  client.connect()
}

function paintLoading(progress: LoadProgress, status: string): void {
  drawLoading(
    canvasView.context,
    canvasView.width,
    canvasView.height,
    progress.completed / Math.max(1, progress.total),
    progress.completed,
    progress.total,
    status,
  )
}

function showRetry(error: unknown): void {
  overlay.replaceChildren()
  const panel = document.createElement('section')
  panel.className = 'error-panel'
  const heading = document.createElement('h2')
  heading.textContent = 'Flight resources could not be prepared'
  const explanation = document.createElement('p')
  const details =
    error instanceof Error && 'failures' in error && Array.isArray(error.failures)
      ? error.failures
          .map((failure: unknown) =>
            typeof failure === 'object' && failure !== null && 'id' in failure && 'error' in failure
              ? `${String(failure.id)}: ${failure.error instanceof Error ? failure.error.message : String(failure.error)}`
              : 'Asset failed to load',
          )
          .join('\n')
      : ''
  explanation.textContent = details || (error instanceof Error ? error.message : String(error))
  const retry = document.createElement('button')
  retry.textContent = 'Retry loading'
  retry.addEventListener('click', () => void startLoading())
  panel.append(heading, explanation, retry)
  overlay.append(panel)
}

async function startLoading(): Promise<void> {
  loadingController?.abort()
  loadingController = new AbortController()
  const signal = loadingController.signal
  overlay.replaceChildren()
  lobbyRoot.replaceChildren()
  tools.replaceChildren()
  paintLoading({ completed: 0, total: 1 }, 'Reading asset manifest...')

  try {
    const rawManifest = await withRetry(
      (retrySignal) => loadJson('/assets/manifest.json', retrySignal),
      { signal, attempts: 3 },
    )
    const manifest = parseAssetManifest(rawManifest)
    paintLoading({ completed: 0, total: 1 }, 'Loading sprites, sounds and arena data...')

    if (!audioContext && 'AudioContext' in window) audioContext = new AudioContext()
    const result = await loadAll(manifest, {
      context: audioContext,
      signal,
      onProgress: ({ completed, total, id }) =>
        paintLoading({ completed, total }, `Loading ${id}...`),
    })

    loadedResources = result.assets
    startLobby(result.failures)
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') return
    showRetry(error)
  }
}

function showFailureResults(failures: AssetFailure[]): void {
  if (!failures.length) return
  const notice = document.createElement('p')
  notice.className = 'optional-assets-note'
  notice.textContent = `Optional sounds unavailable: ${failures.map((failure) => failure.id).join(', ')}. Flight can still start.`
  lobbyRoot.prepend(notice)
}

function startLobby(optionalFailures: AssetFailure[] = []): void {
  setupSocketClient()
  overlay.replaceChildren()
  if (!lobby) lobby = new Lobby({ pollMs: 5000, timeoutMs: 2500 })
  showFailureResults(optionalFailures)

  lobbyView = mountLobbyView(lobbyRoot, lobby, {
    onJoin: joinGame,
    onFailureTests: runFailureGallery,
    onTimingTest: compareLoadingTimes,
  })
  const joinButton = lobbyView.element.querySelector<HTMLButtonElement>('button[type="submit"]')
  if (joinButton) {
    joinButton.addEventListener('pointerdown', unlockAudio, { once: true })
  }
  void lobby.enter()
}

async function unlockAudio(): Promise<void> {
  if (!audioContext || !loadedResources) return
  try {
    if (!audioPlayer) {
      const events = gameEvents
      audioPlayer = createAudioPlayer(audioContext, loadedResources.sounds, events)
    }
    await audioPlayer.unlock()
  } catch (error) {
    const notice = document.createElement('p')
    notice.className = 'optional-assets-note'
    notice.textContent = `Audio is unavailable: ${error instanceof Error ? error.message : String(error)}`
    lobbyRoot.prepend(notice)
  }
}

const gameEvents = new GameEvents()
gameEvents.addEventListener('fired', () => {})

async function joinGame({
  roomId,
  playerName,
}: {
  roomId: string
  playerName: string
}): Promise<void> {
  await unlockAudio()
  const client = socketClient
  const resources = loadedResources
  if (!client || !resources) throw new Error('Flight resources are not ready')
  const { room, player } = await client.join(
    roomId,
    playerName,
    parseCodec(getValueElement('#networkCodec').value),
  )

  lobby?.leave()
  currentGame?.stop()
  lobbyView?.hide()
  overlay.replaceChildren()
  tools.replaceChildren()

  const backButton = document.createElement('button')
  backButton.className = 'back-button'
  backButton.textContent = 'Leave game'
  backButton.addEventListener('click', returnToLobby)
  tools.append(backButton, createBotControls(room, player))

  currentGame = createNetworkGameSession({
    canvasView,
    assets: resources,
    room,
    playerName,
    player,
    socketClient: client,
  })
  currentGame.netcode.setInterpolationDelay(
    Number(getValueElement('#interpolationDelay').value),
  )
  currentGame.start()
  if (netgraphTimer !== null) clearInterval(netgraphTimer)
  netgraphTimer = setInterval(updateNetgraph, 250)
}

function createBotControls(room: LobbyRoom, player: PlayerIdentity): HTMLElement {
  const controls = document.createElement('section')
  controls.className = 'bot-controls'
  const start = document.createElement('button')
  start.type = 'button'
  start.textContent = 'Start 8 Worker bots'
  start.disabled = room.capacity - room.players < 8
  const stop = document.createElement('button')
  stop.type = 'button'
  stop.textContent = 'Stop Worker bots'
  stop.disabled = true
  const status = document.createElement('output')
  status.id = 'botStatus'
  status.setAttribute('aria-live', 'polite')
  status.textContent = start.disabled
    ? 'The room needs at least 8 free places for bots.'
    : 'Bots send the same 30 Hz input protocol as human clients.'

  start.addEventListener('click', () => {
    if (botWorker) return
    const worker = new Worker(new URL('./bot.worker.ts', import.meta.url), {
      type: 'module',
    })
    botWorker = worker
    let connectedBots = 0
    worker.addEventListener('message', (event: MessageEvent<unknown>) => {
      const message = event.data
      if (typeof message !== 'object' || message === null || !('type' in message)) {
        return
      }
      if (message.type === 'bot-connected') {
        connectedBots += 1
        status.textContent = `${connectedBots}/8 Worker bots connected`
      } else if (message.type === 'bot-error') {
        const detail =
          'message' in message && typeof message.message === 'string'
            ? message.message
            : 'Invalid worker error response'
        status.textContent = `Bot connection failed: ${detail}`
        worker.terminate()
        if (botWorker === worker) botWorker = null
        start.disabled = room.capacity - room.players < 8
        stop.disabled = true
      } else if (message.type === 'bots-stopped') {
        worker.terminate()
        if (botWorker === worker) botWorker = null
        start.disabled = room.capacity - room.players < 8
        stop.disabled = true
        status.textContent = 'Worker bots stopped.'
      }
    })
    worker.addEventListener('error', (event) => {
      status.textContent = `Worker failed: ${event.message}`
      worker.terminate()
      if (botWorker === worker) botWorker = null
      start.disabled = room.capacity - room.players < 8
      stop.disabled = true
    })
    worker.postMessage({
      type: 'start',
      roomId: room.id,
      playerName: player.name,
      url: `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws`,
      count: 8,
    })
    start.disabled = true
    stop.disabled = false
    status.textContent = 'Connecting 8 Worker bots...'
  })

  stop.addEventListener('click', () => {
    botWorker?.postMessage({ type: 'stop' })
  })
  controls.append(start, stop, status)
  return controls
}

function returnToLobby(): void {
  botWorker?.postMessage({ type: 'stop' })
  botWorker?.terminate()
  botWorker = null
  socketClient?.leave()
  if (netgraphTimer !== null) clearInterval(netgraphTimer)
  netgraphTimer = null
  currentGame?.stop()
  currentGame = null
  tools.replaceChildren()
  lobbyView?.show()
  void lobby?.enter()
}

function updateNetgraph(): void {
  const current = currentGame
  if (!current) return
  const latest = current.netcode.buffer.latest
  const age = latest ? Math.max(0, performance.now() - latest.receivedAt).toFixed(1) : '--'
  const client = socketClient
  if (!client) return
  const element = getElement('#netgraph')
  const traffic = client.traffic()
  element.textContent =
    `Codec: ${client.codec.toUpperCase()} · RTT: ${client.rttMs === null ? '--' : `${client.rttMs.toFixed(1)} ms`}` +
    ` · Snapshot age: ${age} ms · Input pending: ${current.netcode.pendingCount}` +
    ` · Correction: ${current.netcode.correction.toFixed(2)} px` +
    ` · Traffic in/out: ${traffic.inboundKilobytesPerSecond.toFixed(1)}/${traffic.outboundKilobytesPerSecond.toFixed(1)} KB/s` +
    ` · Snapshots: ${client.snapshotCount}`
}

function measureCodecs(): void {
  const snapshot = decodeBinary(encodeBinary({
    type: 'snapshot',
    tick: 900,
    acks: [{ entityId: 7, seq: 300 }],
    entities: [{
      id: 7,
      kind: 'ship',
      x: 120.25,
      y: 180.5,
      vx: 42.125,
      vy: -11.75,
      angle: -1.57075,
      radius: 13,
      hp: 3,
      thrust: 1,
      invulnerableTime: 0,
      shield: false,
      ownerId: 0,
      ttl: 0,
      commandSeq: 0,
      score: 0,
    }],
  }))
  if (snapshot.type !== 'snapshot') throw new TypeError('Expected snapshot codec result')
  const json = JSON.stringify({ version: 0, ...snapshot })
  const binary = encodeBinary(snapshot)
  const repetitions = 5000
  const jsonStart = performance.now()
  for (let index = 0; index < repetitions; index += 1) {
    JSON.parse(json)
    JSON.stringify({ version: 0, ...snapshot })
  }
  const jsonElapsed = performance.now() - jsonStart
  const binaryStart = performance.now()
  for (let index = 0; index < repetitions; index += 1) {
    decodeBinary(binary)
    encodeBinary(snapshot)
  }
  const binaryElapsed = performance.now() - binaryStart
  getElement('#codecMeasurement').textContent = JSON.stringify({
    repetitions,
    snapshotEntities: snapshot.entities.length,
    jsonBytes: new TextEncoder().encode(json).byteLength,
    binaryBytes: binary.byteLength,
    jsonEncodeDecodeUs: Number((jsonElapsed * 1000 / repetitions).toFixed(2)),
    binaryEncodeDecodeUs: Number((binaryElapsed * 1000 / repetitions).toFixed(2)),
    note: 'Measure on the same browser/device; timing is workload- and runtime-dependent.',
  }, null, 2)
}

window.addEventListener('beforeunload', () => {
  botWorker?.postMessage({ type: 'stop' })
  botWorker?.terminate()
  loadingController?.abort()
  lobby?.destroy()
  currentGame?.stop()
  audioPlayer?.destroy()
  socketClient?.destroy()
  networkEmulator.dispose()
  if (netgraphTimer !== null) clearInterval(netgraphTimer)
  void audioContext?.close()
})

void startLoading()
