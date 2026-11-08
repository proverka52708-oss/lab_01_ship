export function mountLobbyView(root, lobby, { onJoin, onFailureTests, onTimingTest }) {
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

  const form = panel.querySelector('#joinForm')
  const select = form.elements.roomId
  const status = panel.querySelector('#lobbyStatus')
  const feedback = panel.querySelector('#lobbyFeedback')
  const results = panel.querySelector('#failureResults')

  lobby.addEventListener('rooms', (event) => {
    const selected = select.value
    select.replaceChildren(
      ...event.detail.map((room) => {
        const option = document.createElement('option')
        option.value = room.id
        option.textContent = `${room.name} · ${room.players}/${room.capacity}`
        return option
      }),
    )
    if (event.detail.some((room) => room.id === selected)) select.value = selected
    status.textContent = `${event.detail.length} rooms · refreshed`
    status.classList.add('is-ready')
  })

  lobby.addEventListener('error', (event) => {
    status.textContent = 'offline · retrying'
    feedback.textContent = `Room list unavailable: ${event.detail.message}`
  })

  form.addEventListener('submit', async (event) => {
    event.preventDefault()
    const data = new FormData(form)
    try {
      await onJoin({ roomId: data.get('roomId'), playerName: data.get('playerName') })
    } catch (error) {
      feedback.textContent = error.message
    }
  })

  panel.querySelector('#failureButton').addEventListener('click', async () => {
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

  panel.querySelector('#timingButton').addEventListener('click', async () => {
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
