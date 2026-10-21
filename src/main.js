import './style.css'
import { setupCanvas } from './render/canvas.js'
import { drawLoading } from './render/draw.js'
import { fetchJson, loadAll, loadJson, withRetry } from './assets/loader.js'
import { runFailureGallery, compareLoadingTimes } from './assets/failure-gallery.js'
import { createGameSession } from './game/game-session.js'
import { Lobby } from './lobby/lobby.js'
import { mountLobbyView } from './lobby/view.js'
import { GameEvents } from './audio/game-events.js'
import { createAudioPlayer } from './audio/audio-player.js'

const app = document.querySelector('#app')
app.innerHTML = `
  <main class="game-shell">
    <header class="game-header">
      <div>
        <p class="eyebrow">LAB 03 / ASYNC FLIGHT SYSTEMS</p>
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
  const { rooms } = await fetchJson('/api/rooms')
  const room = rooms.find((item) => item.id === roomId)
  if (!room) throw new Error('That room is no longer available. Refresh the lobby.')

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

  currentGame = createGameSession({
    canvasView,
    assets: loadedResources,
    events: gameEvents,
    room,
    playerName,
  })
  currentGame.start()
}

function returnToLobby() {
  currentGame?.stop()
  currentGame = null
  tools.replaceChildren()
  lobbyView?.show()
  void lobby?.enter()
}

window.addEventListener('beforeunload', () => {
  loadingController?.abort()
  lobby?.destroy()
  currentGame?.stop()
  audioPlayer?.destroy()
  void audioContext?.close()
})

void startLoading()
