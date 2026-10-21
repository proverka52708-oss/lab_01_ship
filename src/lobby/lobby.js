import { fetchJson } from '../assets/loader.js'

export class Lobby extends EventTarget {
  #controller = null
  #timer = null
  #visible = false
  #rooms = []

  constructor({ pollMs = 5000, timeoutMs = 2500 } = {}) {
    super()
    this.pollMs = pollMs
    this.timeoutMs = timeoutMs
  }

  get rooms() {
    return this.#rooms
  }

  async refresh() {
    if (!this.#visible) return []
    this.#controller?.abort()
    const controller = new AbortController()
    this.#controller = controller

    try {
      const response = await fetchJson('/api/rooms', {
        signal: controller.signal,
        timeoutMs: this.timeoutMs,
      })
      if (!this.#visible || controller.signal.aborted) return []
      this.#rooms = response.rooms
      this.dispatchEvent(new CustomEvent('rooms', { detail: this.#rooms }))
      return this.#rooms
    } catch (error) {
      if (error.name !== 'AbortError') {
        this.dispatchEvent(new CustomEvent('error', { detail: error }))
      }
      return []
    }
  }

  async enter() {
    this.#visible = true
    await this.refresh()
    if (!this.#visible) return
    clearInterval(this.#timer)
    this.#timer = setInterval(() => void this.refresh(), this.pollMs)
  }

  leave() {
    this.#visible = false
    clearInterval(this.#timer)
    this.#timer = null
    this.#controller?.abort()
    this.#controller = null
    this.dispatchEvent(new Event('leave'))
  }

  join(roomId, playerName) {
    const room = this.#rooms.find((candidate) => candidate.id === roomId)
    if (!room) throw new Error('Choose an available room first')
    this.leave()
    this.dispatchEvent(new CustomEvent('join', { detail: { room, playerName } }))
    return room
  }

  destroy() {
    this.leave()
  }
}
