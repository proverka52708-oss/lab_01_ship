import { decodeBinary, encodeBinary } from '@dogfight/shared/codec'
import type { BinaryMessage } from '@dogfight/shared/codec'
import type { WireInputFields } from '@dogfight/shared/protocol'
import { GameSnapshotSchema } from '@dogfight/shared/protocol'
import type { NetworkEmulator } from '../network-emulator.ts'
import { isLobbyRoom, type LobbyRoom } from '../lobby/lobby.ts'

export type Codec = 'json' | 'binary'
export interface PlayerIdentity {
  id: string
  entityId: number
  name: string
}
export interface JoinedMessage {
  type: 'joined'
  room: LobbyRoom
  player: PlayerIdentity
}
export type SnapshotMessage = Extract<BinaryMessage, { type: 'snapshot' }>
export type ServerMessage =
  | JoinedMessage
  | SnapshotMessage
  | { type: 'pong'; sentAt: number }
  | { type: 'player-joined'; player: PlayerIdentity }
  | { type: 'player-left'; player: Pick<PlayerIdentity, 'name'> }
  | { type: 'chat'; player: string; text: string }
  | { type: 'server-error'; message: string }
type OutboundMessage =
  | { type: 'join'; roomId: string; playerName: string; codec: Codec }
  | { type: 'chat'; text: string }
  | { type: 'leave' }
  | { type: 'ping'; version: number; sentAt: number }
  | ({ type: 'input'; version: number } & WireInputFields)
  | ArrayBuffer
  | ArrayBufferView
  | string
interface PendingJoin {
  resolve(message: JoinedMessage): void
  reject(error: Error): void
  timer: ReturnType<typeof setTimeout>
}
interface TrafficEvent {
  direction: 'in' | 'out'
  bytes: number
  at: number
}
interface DesiredRoom {
  roomId: string
  playerName: string
  codec: Codec
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function parseServerMessage(value: unknown): ServerMessage {
  if (!isRecord(value) || typeof value.type !== 'string') {
    throw new TypeError('Server message is invalid')
  }
  switch (value.type) {
    case 'snapshot':
      return GameSnapshotSchema.parse(value)
    case 'pong':
      if (typeof value.sentAt !== 'number') throw new TypeError('Server pong is invalid')
      return { type: 'pong', sentAt: value.sentAt }
    case 'joined': {
      if (
        !isLobbyRoom(value.room) ||
        !isRecord(value.player) ||
        typeof value.player.id !== 'string' ||
        typeof value.player.entityId !== 'number' ||
        typeof value.player.name !== 'string'
      ) {
        throw new TypeError('Server join response is invalid')
      }
      return {
        type: 'joined',
        room: value.room,
        player: {
          id: value.player.id,
          entityId: value.player.entityId,
          name: value.player.name,
        },
      }
    }
    case 'player-joined':
    case 'player-left':
      if (!isRecord(value.player) || typeof value.player.name !== 'string') {
        throw new TypeError('Server player event is invalid')
      }
      if (
        value.type === 'player-joined' &&
        typeof value.player.id === 'string' &&
        typeof value.player.entityId === 'number'
      ) {
        return {
          type: 'player-joined',
          player: {
            id: value.player.id,
            entityId: value.player.entityId,
            name: value.player.name,
          },
        }
      }
      if (value.type === 'player-left') {
        return { type: 'player-left', player: { name: value.player.name } }
      }
      throw new TypeError('Server player event is invalid')
    case 'chat':
      if (typeof value.player !== 'string' || typeof value.text !== 'string') {
        throw new TypeError('Server chat message is invalid')
      }
      return { type: 'chat', player: value.player, text: value.text }
    case 'server-error':
      if (typeof value.message !== 'string') throw new TypeError('Server error message is invalid')
      return { type: 'server-error', message: value.message }
    default:
      throw new TypeError('Server message type is unsupported')
  }
}

const MAX_QUEUED_MESSAGES = 100
const MAX_BUFFERED_BYTES = 128 * 1024

export class SocketClient extends EventTarget {
  readonly url: string
  #socket: WebSocket | null = null
  #retryDelay = 500
  #retryTimer: ReturnType<typeof setTimeout> | null = null
  #flushTimer: ReturnType<typeof setTimeout> | null = null
  #queue: OutboundMessage[] = []
  #desiredRoom: DesiredRoom | null = null
  #pendingJoin: PendingJoin | null = null
  #stopped = false
  #codec: Codec = 'json'
  #networkEmulator: NetworkEmulator | null = null
  #pingTimer: ReturnType<typeof setInterval> | null = null
  #rttMs: number | null = null
  #trafficEvents: TrafficEvent[] = []
  #snapshotCount = 0

  constructor(
    url = `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws`,
  ) {
    super()
    this.url = url
  }

  connect(): void {
    if (this.#stopped || this.#socket) return
    this.dispatchEvent(new CustomEvent<string>('status', { detail: 'connecting' }))
    const socket = new WebSocket(this.url)
    socket.binaryType = 'arraybuffer'
    this.#socket = socket

    socket.addEventListener('open', () => {
      if (this.#socket !== socket) return
      this.#retryDelay = 500
      this.dispatchEvent(new CustomEvent<string>('status', { detail: 'connected' }))
      if (this.#desiredRoom) {
        this.#sendNow({
          type: 'join',
          roomId: this.#desiredRoom.roomId,
          playerName: this.#desiredRoom.playerName,
          codec: this.#desiredRoom.codec,
        })
      }
      this.#flushQueue()
      if (this.#pingTimer !== null) clearInterval(this.#pingTimer)
      this.#pingTimer = setInterval(() => this.#sendPing(), 1000)
    })

    socket.addEventListener('message', (event) => {
      let message: ServerMessage
      try {
        const data: unknown = event.data
        if (typeof data === 'string') {
          const parsed: unknown = JSON.parse(data)
          message = parseServerMessage(parsed)
        } else if (data instanceof ArrayBuffer) {
          message = parseServerMessage(decodeBinary(data))
        } else {
          throw new TypeError('WebSocket message payload is unsupported')
        }
      } catch (error) {
        this.dispatchEvent(new CustomEvent<unknown>('protocol-error', { detail: error }))
        return
      }
      this.#recordTraffic(
        'in',
        typeof event.data === 'string'
          ? new TextEncoder().encode(event.data).byteLength
          : event.data instanceof ArrayBuffer
            ? event.data.byteLength
            : 0,
      )
      if (message.type === 'snapshot') this.#snapshotCount += 1
      if (message.type === 'pong' && Number.isFinite(message.sentAt)) {
        this.#rttMs = Math.max(0, performance.now() - message.sentAt)
      }
      if (message.type === 'joined' && this.#pendingJoin) {
        clearTimeout(this.#pendingJoin.timer)
        this.#pendingJoin.resolve(message)
        this.#pendingJoin = null
      } else if (message.type === 'server-error' && this.#pendingJoin) {
        clearTimeout(this.#pendingJoin.timer)
        this.#pendingJoin.reject(new Error(message.message))
        this.#pendingJoin = null
        this.#desiredRoom = null
      }
      const deliver = () =>
        this.dispatchEvent(new CustomEvent<ServerMessage>('message', { detail: message }))
      if (message.type === 'snapshot' && this.#networkEmulator) {
        this.#networkEmulator.transmit(deliver, 'down')
      } else {
        deliver()
      }
    })

    socket.addEventListener('close', (event) => {
      if (this.#socket !== socket) return
      this.#socket = null
      if (this.#pingTimer !== null) clearInterval(this.#pingTimer)
      this.#pingTimer = null
      this.dispatchEvent(
        new CustomEvent<string>('status', {
          detail: this.#stopped ? 'disconnected' : 'reconnecting',
        }),
      )
      this.dispatchEvent(new CustomEvent<CloseEvent>('close', { detail: event }))
      if (!this.#stopped) this.#scheduleReconnect()
    })

    socket.addEventListener('error', () => {
      this.dispatchEvent(
        new CustomEvent<string>('socket-error', { detail: 'WebSocket connection failed' }),
      )
    })
  }

  join(roomId: string, playerName: string, codec: Codec = this.#codec): Promise<JoinedMessage> {
    if (codec !== 'json' && codec !== 'binary') {
      return Promise.reject(new Error('Choose JSON or binary encoding'))
    }
    this.#codec = codec
    if (this.#pendingJoin) {
      clearTimeout(this.#pendingJoin.timer)
      this.#pendingJoin.reject(new Error('A room join is already pending'))
    }

    this.#desiredRoom = { roomId, playerName, codec }
    const joined = new Promise<JoinedMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.#pendingJoin) return
        this.#pendingJoin = null
        this.#desiredRoom = null
        reject(new Error('Room join timed out'))
      }, 6500)
      this.#pendingJoin = { resolve, reject, timer }
    })
    if (this.#socket?.readyState === WebSocket.OPEN) {
      this.#sendNow({ type: 'join', roomId, playerName, codec })
    }
    return joined
  }

  send(message: OutboundMessage): void {
    if (this.#stopped) throw new Error('WebSocket client has been stopped')
    if (
      this.#socket?.readyState === WebSocket.OPEN &&
      this.#socket.bufferedAmount <= MAX_BUFFERED_BYTES
    ) {
      this.#sendNow(message)
      return
    }
    if (this.#queue.length >= MAX_QUEUED_MESSAGES) {
      throw new Error('WebSocket send queue is full')
    }
    this.#queue.push(message)
    this.#scheduleFlush()
  }

  sendInput(command: WireInputFields): void {
    const message: OutboundMessage = { type: 'input', version: 0, ...command }
    const payload =
      this.#codec === 'binary'
        ? encodeBinary(message)
        : message
    const send = () => {
      try {
        this.send(payload)
      } catch {
        // A delayed emulated packet may outlive the socket.
      }
    }
    if (this.#networkEmulator) {
      this.#networkEmulator.transmit(send, 'up')
    } else {
      send()
    }
  }

  setNetworkEmulator(emulator: NetworkEmulator | null): void {
    this.#networkEmulator = emulator
  }

  get codec(): Codec {
    return this.#codec
  }

  get rttMs(): number | null {
    return this.#rttMs
  }

  get snapshotCount(): number {
    return this.#snapshotCount
  }

  traffic(): { inboundKilobytesPerSecond: number; outboundKilobytesPerSecond: number } {
    const now = performance.now()
    this.#trafficEvents = this.#trafficEvents.filter((item) => now - item.at <= 1000)
    const inbound = this.#trafficEvents
      .filter((item) => item.direction === 'in')
      .reduce((sum, item) => sum + item.bytes, 0)
    const outbound = this.#trafficEvents
      .filter((item) => item.direction === 'out')
      .reduce((sum, item) => sum + item.bytes, 0)
    return {
      inboundKilobytesPerSecond: inbound / 1024,
      outboundKilobytesPerSecond: outbound / 1024,
    }
  }

  leave(): void {
    this.#desiredRoom = null
    if (this.#pendingJoin) {
      clearTimeout(this.#pendingJoin.timer)
      this.#pendingJoin.reject(new Error('Room join was cancelled'))
      this.#pendingJoin = null
    }
    if (this.#socket?.readyState === WebSocket.OPEN) this.#sendNow({ type: 'leave' })
  }

  destroy(): void {
    this.#stopped = true
    if (this.#retryTimer !== null) clearTimeout(this.#retryTimer)
    if (this.#flushTimer !== null) clearTimeout(this.#flushTimer)
    if (this.#pingTimer !== null) clearInterval(this.#pingTimer)
    this.leave()
    this.#socket?.close(1000, 'Client stopped')
  }

  #sendNow(message: OutboundMessage | undefined): void {
    if (this.#socket?.readyState === WebSocket.OPEN) {
      const payload: string | ArrayBuffer =
        typeof message === 'string' || message instanceof ArrayBuffer
          ? message
          : ArrayBuffer.isView(message)
            ? new Uint8Array(
                message.buffer,
                message.byteOffset,
                message.byteLength,
              ).slice().buffer
            : JSON.stringify(message)
      this.#socket.send(payload)
      this.#recordTraffic(
        'out',
        typeof payload === 'string'
          ? new TextEncoder().encode(payload).byteLength
          : payload.byteLength,
      )
    }
  }

  #sendPing(): void {
    if (!this.#desiredRoom || this.#socket?.readyState !== WebSocket.OPEN) return
    const sentAt = performance.now()
    const message: OutboundMessage = { type: 'ping', version: 0, sentAt }
    this.#sendNow(this.#codec === 'binary' ? encodeBinary(message) : message)
  }

  #recordTraffic(direction: TrafficEvent['direction'], bytes: number): void {
    this.#trafficEvents.push({ direction, bytes, at: performance.now() })
  }

  #flushQueue(): void {
    while (
      this.#queue.length &&
      this.#socket?.readyState === WebSocket.OPEN &&
      this.#socket.bufferedAmount <= MAX_BUFFERED_BYTES
    ) {
      this.#sendNow(this.#queue.shift())
    }
    if (this.#queue.length) this.#scheduleFlush()
  }

  #scheduleFlush(): void {
    if (this.#flushTimer || this.#stopped) return
    this.#flushTimer = setTimeout(() => {
      this.#flushTimer = null
      this.#flushQueue()
    }, 100)
  }

  #scheduleReconnect(): void {
    if (this.#retryTimer !== null) clearTimeout(this.#retryTimer)
    const wait = this.#retryDelay
    this.#retryDelay = Math.min(this.#retryDelay * 2, 10_000)
    this.#retryTimer = setTimeout(() => {
      this.#retryTimer = null
      this.connect()
    }, wait)
  }
}
