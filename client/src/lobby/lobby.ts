import { fetchJson } from '../assets/loader.ts'

export interface LobbyRoom {
  id: string
  name: string
  players: number
  capacity: number
  arena?: { width?: number; height?: number; asteroidCount?: number }
}

interface LobbyOptions {
  pollMs?: number
  timeoutMs?: number
}

export function isLobbyRoom(value: unknown): value is LobbyRoom {
  if (typeof value !== 'object' || value === null) return false
  return (
    'id' in value &&
    typeof value.id === 'string' &&
    'name' in value &&
    typeof value.name === 'string' &&
    'players' in value &&
    typeof value.players === 'number' &&
    'capacity' in value &&
    typeof value.capacity === 'number'
  )
}

function parseRooms(response: unknown): LobbyRoom[] {
  if (typeof response !== 'object' || response === null || !('rooms' in response)) {
    throw new TypeError('Room list response is invalid')
  }
  const rooms = response.rooms
  if (!Array.isArray(rooms) || !rooms.every(isLobbyRoom)) {
    throw new TypeError('Room list response is invalid')
  }
  if (new Set(rooms.map((room) => room.id)).size !== rooms.length) {
    throw new TypeError('Room list contains duplicate room ids')
  }
  return rooms
}

export class Lobby extends EventTarget {
  #controller: AbortController | null = null
  #timer: ReturnType<typeof setInterval> | null = null
  #visible = false
  #rooms: LobbyRoom[] = []
  readonly pollMs: number
  readonly timeoutMs: number

  constructor({ pollMs = 5000, timeoutMs = 2500 }: LobbyOptions = {}) {
    super()
    this.pollMs = pollMs
    this.timeoutMs = timeoutMs
  }

  get rooms(): LobbyRoom[] {
    return this.#rooms
  }

  async refresh(): Promise<LobbyRoom[]> {
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
      this.#rooms = parseRooms(response)
      this.dispatchEvent(new CustomEvent<LobbyRoom[]>('rooms', { detail: this.#rooms }))
      return this.#rooms
    } catch (error) {
      if (!(error instanceof Error) || error.name !== 'AbortError') {
        this.dispatchEvent(new CustomEvent<unknown>('error', { detail: error }))
      }
      return []
    }
  }

  async enter(): Promise<void> {
    this.#visible = true
    await this.refresh()
    if (!this.#visible) return
    if (this.#timer !== null) clearInterval(this.#timer)
    this.#timer = setInterval(() => void this.refresh(), this.pollMs)
  }

  leave(): void {
    this.#visible = false
    if (this.#timer !== null) clearInterval(this.#timer)
    this.#timer = null
    this.#controller?.abort()
    this.#controller = null
    this.dispatchEvent(new Event('leave'))
  }

  join(roomId: string, playerName: string): LobbyRoom {
    const room = this.#rooms.find((candidate) => candidate.id === roomId)
    if (!room) throw new Error('Choose an available room first')
    this.leave()
    this.dispatchEvent(
      new CustomEvent<{ room: LobbyRoom; playerName: string }>('join', {
        detail: { room, playerName },
      }),
    )
    return room
  }

  destroy(): void {
    this.leave()
  }
}
