import type { FailureResult } from '../assets/failure-gallery.ts'
import type { Lobby } from './lobby.ts'

interface LobbyViewOptions {
  onJoin(input: { roomId: string; playerName: string }): Promise<unknown>
  onFailureTests(): Promise<FailureResult[]>
  onTimingTest(): Promise<{ sequential: number; concurrent: number }>
}

function requiredElement<T extends Element>(root: ParentNode, selector: string): T {
  const element = root.querySelector<T>(selector)
  if (!element) throw new Error(`Lobby element not found: ${selector}`)
  return element
}

export function mountLobbyView(
  root: HTMLElement,
  lobby: Lobby,
  { onJoin, onFailureTests, onTimingTest }: LobbyViewOptions,
): { show(): void; hide(): void; element: HTMLElement } {
  const panel = document.createElement('section')
  panel.className = 'lobby-panel'
  panel.innerHTML = `
    <div class="lobby-heading">
      <div>
        <p class="eyebrow">STAR RUNNER / HTTP LOBBY</p>
        <h2>Choose a room</h2>
      </div>
      <span id="lobbyStatus" class="status-light">connecting</span>
    </div>
    <form id="joinForm" class="join-form">
      <label>Player name<input name="playerName" maxlength="18" value="Pilot" required /></label>
      <label>Room<select name="roomId" required><option value="">Loading rooms...</option></select></label>
      <button type="submit">Join game</button>
    </form>
    <div class="lobby-tools">
      <button id="timingButton" type="button" class="quiet-button">Compare sequential / concurrent</button>
      <button id="failureButton" type="button" class="quiet-button">Run failure gallery</button>
    </div>
    <div id="lobbyFeedback" class="lobby-feedback" aria-live="polite"></div>
    <ol id="failureResults" class="failure-results" aria-live="polite"></ol>
  `
  root.replaceChildren(panel)

  const form = requiredElement<HTMLFormElement>(panel, '#joinForm')
  const select = requiredElement<HTMLSelectElement>(form, '[name="roomId"]')
  const status = requiredElement<HTMLElement>(panel, '#lobbyStatus')
  const feedback = requiredElement<HTMLElement>(panel, '#lobbyFeedback')
  const results = requiredElement<HTMLOListElement>(panel, '#failureResults')

  lobby.addEventListener('rooms', (event) => {
    const rooms = lobby.rooms
    const selected = select.value
    select.replaceChildren(
      ...rooms.map((room) => {
        const option = document.createElement('option')
        option.value = room.id
        option.textContent = `${room.name} · ${room.players}/${room.capacity}`
        return option
      }),
    )
    if (rooms.some((room) => room.id === selected)) select.value = selected
    status.textContent = `${rooms.length} rooms · refreshed`
    status.classList.add('is-ready')
  })

  lobby.addEventListener('error', (event) => {
    status.textContent = 'offline · retrying'
    const error = event instanceof CustomEvent ? event.detail : undefined
    feedback.textContent = `Room list unavailable: ${error instanceof Error ? error.message : 'Unknown error'}`
  })

  form.addEventListener('submit', async (event) => {
    event.preventDefault()
    const data = new FormData(form)
    try {
      const roomId = data.get('roomId')
      const playerName = data.get('playerName')
      if (typeof roomId !== 'string' || typeof playerName !== 'string') {
        throw new TypeError('Room and player name are required')
      }
      await onJoin({ roomId, playerName })
    } catch (error) {
      feedback.textContent = error instanceof Error ? error.message : 'Unable to join room'
    }
  })

  requiredElement<HTMLButtonElement>(panel, '#failureButton').addEventListener('click', async () => {
    results.replaceChildren()
    panel.querySelectorAll('button').forEach((button) => (button.disabled = true))
    try {
      const failures = await onFailureTests()
      for (const result of failures) {
        const item = document.createElement('li')
        item.className = result.recovered ? 'test-passed' : 'test-failed'
        item.textContent = `${result.label}: ${result.message}`
        results.append(item)
      }
    } finally {
      panel.querySelectorAll('button').forEach((button) => (button.disabled = false))
    }
  })

  requiredElement<HTMLButtonElement>(panel, '#timingButton').addEventListener('click', async () => {
    feedback.textContent = 'Measuring two 250 ms jobs...'
    const result = await onTimingTest()
    feedback.textContent = `Sequential: ${result.sequential} ms · concurrent: ${result.concurrent} ms`
  })

  return {
    show() {
      panel.hidden = false
    },
    hide() {
      panel.hidden = true
    },
    element: panel,
  }
}
