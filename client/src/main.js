import './style.css'
import { setupCanvas } from './render/canvas.js'
import { drawLoading } from './render/draw.js'
import { fetchJson, loadAll, loadJson, withRetry } from './assets/loader.js'
import { runFailureGallery, compareLoadingTimes } from './assets/failure-gallery.js'
import { Lobby } from './lobby/lobby.js'
import { mountLobbyView } from './lobby/view.js'
import { GameEvents } from './audio/game-events.js'
import { createAudioPlayer } from './audio/audio-player.js'
import { SocketClient } from './net/socket-client.js'
import { NetworkEmulator } from './network-emulator.js'
import { createNetworkGameSession } from './game/network-game-session.js'
import { decodeBinary, encodeBinary } from '@dogfight/shared/codec'

const app = document.querySelector('#app')
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

const canvas = document.querySelector('#gameCanvas')
const canvasView = setupCanvas(canvas)
const overlay = document.querySelector('#stageOverlay')
const tools = document.querySelector('#stageTools')
const lobbyRoot = document.querySelector('#lobbyRoot')
let audioContext = null
let audioPlayer = null
let currentGame = null
let lobby = null
let lobbyView = null
let loadedResources = null
let loadingController = null
let socketClient = null
const networkEmulator = new NetworkEmulator()
let netgraphTimer = null

function setupSocketClient() {
  if (socketClient) return
  socketClient = new SocketClient()
  socketClient.setNetworkEmulator(networkEmulator)
  socketClient.addEventListener('status', (event) => {
    const status = document.querySelector('#socketStatus')
    status.textContent = event.detail
    status.classList.toggle('is-ready', event.detail === 'connected')
  })
  socketClient.addEventListener('message', (event) => {
    const message = event.detail
    const notice = document.querySelector('#networkNotice')
    const messages = document.querySelector('#chatMessages')
    if (message.type === 'joined') {
      notice.textContent = `Joined ${message.room.name} as ${message.player.name}`
      if (currentGame) currentGame.setIdentity(message.player)
    } else if (message.type === 'snapshot') {
      currentGame?.receiveSnapshot(message)
    } else if (message.type === 'player-joined') {
      notice.textContent = `${message.player.name} joined the room`
    } else if (message.type === 'player-left') {
      notice.textContent = `${message.player.name} left the room`
    } else if (message.type === 'chat') {
      const item = document.createElement('li')
      item.textContent = `${message.player}: ${message.text}`
      messages.append(item)
      messages.scrollTop = messages.scrollHeight
    } else if (message.type === 'server-error') {
      notice.textContent = message.message
    }
  })
  socketClient.addEventListener('close', () => {
    document.querySelector('#networkNotice').textContent =
      'Connection lost. Reconnecting and restoring your room...'
  })
  socketClient.addEventListener('socket-error', (event) => {
    document.querySelector('#networkNotice').textContent = event.detail
  })
  const configureNetwork = () => {
    networkEmulator.configure({
      delayMs: Number(document.querySelector('#networkDelay').value),
      jitterMs: Number(document.querySelector('#networkJitter').value),
      lossPercent: Number(document.querySelector('#networkLoss').value),
    })
    const netcode = currentGame?.netcode
    netcode?.setInterpolationDelay(Number(document.querySelector('#interpolationDelay').value))
    document.querySelector('#networkDelayValue').value = `${document.querySelector('#networkDelay').value} ms`
    document.querySelector('#networkJitterValue').value = `${document.querySelector('#networkJitter').value} ms`
    document.querySelector('#networkLossValue').value = `${document.querySelector('#networkLoss').value}%`
    document.querySelector('#interpolationValue').value = `${document.querySelector('#interpolationDelay').value} ms`
  }
  for (const id of ['networkDelay', 'networkJitter', 'networkLoss', 'interpolationDelay']) {
    document.querySelector(`#${id}`).addEventListener('input', configureNetwork)
  }
  configureNetwork()
  document.querySelector('#measureCodecs').addEventListener('click', measureCodecs)
  document.querySelector('#chatForm').addEventListener('submit', (event) => {
    event.preventDefault()
    const input = document.querySelector('#chatInput')
    try {
      socketClient.send({ type: 'chat', text: input.value })
      input.value = ''
    } catch (error) {
      document.querySelector('#networkNotice').textContent = error.message
    }
  })
  socketClient.connect()
}

function paintLoading(progress, status) {
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

function showRetry(error) {
  overlay.replaceChildren()
  const panel = document.createElement('section')
  panel.className = 'error-panel'
  const heading = document.createElement('h2')
  heading.textContent = 'Flight resources could not be prepared'
  const explanation = document.createElement('p')
  const details = error.failures
    ?.map((failure) => `${failure.id}: ${failure.error.message}`)
    .join('\n')
  explanation.textContent = details || error.message
  const retry = document.createElement('button')
  retry.textContent = 'Retry loading'
  retry.addEventListener('click', () => void startLoading())
  panel.append(heading, explanation, retry)
  overlay.append(panel)
}

async function startLoading() {
  loadingController?.abort()
  loadingController = new AbortController()
  const signal = loadingController.signal
  overlay.replaceChildren()
  lobbyRoot.replaceChildren()
  tools.replaceChildren()
  paintLoading({ completed: 0, total: 1 }, 'Reading asset manifest...')

  try {
    const manifest = await withRetry(
      (retrySignal) => loadJson('/assets/manifest.json', retrySignal),
      { signal, attempts: 3 },
    )
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
    if (error.name === 'AbortError') return
    showRetry(error)
  }
}

function showFailureResults(failures) {
  if (!failures.length) return
  const notice = document.createElement('p')
  notice.className = 'optional-assets-note'
  notice.textContent = `Optional sounds unavailable: ${failures.map((failure) => failure.id).join(', ')}. Flight can still start.`
  lobbyRoot.prepend(notice)
}

function startLobby(optionalFailures = []) {
  setupSocketClient()
  overlay.replaceChildren()
  if (!lobby) lobby = new Lobby({ pollMs: 5000, timeoutMs: 2500 })
  showFailureResults(optionalFailures)

  lobbyView = mountLobbyView(lobbyRoot, lobby, {
    onJoin: joinGame,
    onFailureTests: runFailureGallery,
    onTimingTest: compareLoadingTimes,
  })
  const joinButton = lobbyView.element.querySelector('button[type="submit"]')
  if (joinButton) {
    joinButton.addEventListener('pointerdown', unlockAudio, { once: true })
  }
  void lobby.enter()
}

async function unlockAudio() {
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
    notice.textContent = `Audio is unavailable: ${error.message}`
    lobbyRoot.prepend(notice)
  }
}

const gameEvents = new GameEvents()
gameEvents.addEventListener('fired', () => {})

async function joinGame({ roomId, playerName }) {
  await unlockAudio()
  const { room, player } = await socketClient.join(
    roomId,
    playerName,
    document.querySelector('#networkCodec').value,
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
  tools.append(backButton)

  currentGame = createNetworkGameSession({
    canvasView,
    assets: loadedResources,
    events: gameEvents,
    room,
    playerName,
    player,
    socketClient,
  })
  currentGame.netcode.setInterpolationDelay(
    Number(document.querySelector('#interpolationDelay').value),
  )
  currentGame.start()
  clearInterval(netgraphTimer)
  netgraphTimer = setInterval(updateNetgraph, 250)
}

function returnToLobby() {
  socketClient?.leave()
  clearInterval(netgraphTimer)
  netgraphTimer = null
  currentGame?.stop()
  currentGame = null
  tools.replaceChildren()
  lobbyView?.show()
  void lobby?.enter()
}

function updateNetgraph() {
  const element = document.querySelector('#netgraph')
  if (!element || !currentGame) return
  const latest = currentGame.netcode.buffer.latest
  const age = latest ? Math.max(0, performance.now() - latest.receivedAt).toFixed(1) : '--'
  const traffic = socketClient.traffic()
  element.textContent =
    `Codec: ${socketClient.codec.toUpperCase()} · RTT: ${socketClient.rttMs === null ? '--' : `${socketClient.rttMs.toFixed(1)} ms`}` +
    ` · Snapshot age: ${age} ms · Input pending: ${currentGame.netcode.pendingCount}` +
    ` · Correction: ${currentGame.netcode.correction.toFixed(2)} px` +
    ` · Traffic in/out: ${traffic.inboundKilobytesPerSecond.toFixed(1)}/${traffic.outboundKilobytesPerSecond.toFixed(1)} KB/s` +
    ` · Snapshots: ${socketClient.snapshotCount}`
}

function measureCodecs() {
  const snapshot = {
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
  }
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
  document.querySelector('#codecMeasurement').textContent = JSON.stringify({
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
  loadingController?.abort()
  lobby?.destroy()
  currentGame?.stop()
  audioPlayer?.destroy()
  socketClient?.destroy()
  networkEmulator.dispose()
  clearInterval(netgraphTimer)
  void audioContext?.close()
})

void startLoading()
