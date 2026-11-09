import { decodeBinary, encodeBinary } from '@dogfight/shared/codec'

const MAX_QUEUED_MESSAGES = 100
const MAX_BUFFERED_BYTES = 128 * 1024

export class SocketClient extends EventTarget {
  #socket = null
  #retryDelay = 500
  #retryTimer = null
  #flushTimer = null
  #queue = []
  #desiredRoom = null
  #pendingJoin = null
  #stopped = false
  #codec = 'json'
  #networkEmulator = null
  #pingTimer = null
  #rttMs = null
  #trafficEvents = []
  #snapshotCount = 0

  constructor(
    url = `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws`,
  ) {
    super()
    this.url = url
  }

  connect() {
    if (this.#stopped || this.#socket) return
    this.dispatchEvent(new CustomEvent('status', { detail: 'connecting' }))
    const socket = new WebSocket(this.url)
    socket.binaryType = 'arraybuffer'
    this.#socket = socket

    socket.addEventListener('open', () => {
      if (this.#socket !== socket) return
      this.#retryDelay = 500
      this.dispatchEvent(new CustomEvent('status', { detail: 'connected' }))
      if (this.#desiredRoom) {
        this.#sendNow({
          type: 'join',
          roomId: this.#desiredRoom.roomId,
          playerName: this.#desiredRoom.playerName,
          codec: this.#desiredRoom.codec,
        })
      }
      this.#flushQueue()
      clearInterval(this.#pingTimer)
      this.#pingTimer = setInterval(() => this.#sendPing(), 1000)
    })

    socket.addEventListener('message', (event) => {
      let message
      try {
        message =
          typeof event.data === 'string'
            ? JSON.parse(event.data)
            : decodeBinary(event.data)
      } catch (error) {
        this.dispatchEvent(new CustomEvent('protocol-error', { detail: error }))
        return
      }
      this.#recordTraffic('in', typeof event.data === 'string'
        ? new TextEncoder().encode(event.data).byteLength
        : event.data.byteLength)
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
        this.dispatchEvent(new CustomEvent('message', { detail: message }))
      if (message.type === 'snapshot' && this.#networkEmulator) {
        this.#networkEmulator.transmit(deliver, 'down')
      } else {
        deliver()
      }
    })

    socket.addEventListener('close', (event) => {
      if (this.#socket !== socket) return
      this.#socket = null
      clearInterval(this.#pingTimer)
      this.#pingTimer = null
      this.dispatchEvent(
        new CustomEvent('status', {
          detail: this.#stopped ? 'disconnected' : 'reconnecting',
        }),
      )
      this.dispatchEvent(new CustomEvent('close', { detail: event }))
      if (!this.#stopped) this.#scheduleReconnect()
    })

    socket.addEventListener('error', () => {
      this.dispatchEvent(
        new CustomEvent('socket-error', { detail: 'WebSocket connection failed' }),
      )
    })
  }

  join(roomId, playerName, codec = this.#codec) {
    if (!['json', 'binary'].includes(codec)) {
      return Promise.reject(new Error('Choose JSON or binary encoding'))
    }
    this.#codec = codec
    if (this.#pendingJoin) {
      clearTimeout(this.#pendingJoin.timer)
      this.#pendingJoin.reject(new Error('A room join is already pending'))
    }

    this.#desiredRoom = { roomId, playerName, codec }
    const joined = new Promise((resolve, reject) => {
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

  send(message) {
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

  sendInput(command) {
    const message = { type: 'input', version: 0, ...command }
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

  setNetworkEmulator(emulator) {
    this.#networkEmulator = emulator
  }

  get codec() {
    return this.#codec
  }

  get rttMs() {
    return this.#rttMs
  }

  get snapshotCount() {
    return this.#snapshotCount
  }

  traffic() {
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

  leave() {
    this.#desiredRoom = null
    if (this.#pendingJoin) {
      clearTimeout(this.#pendingJoin.timer)
      this.#pendingJoin.reject(new Error('Room join was cancelled'))
      this.#pendingJoin = null
    }
    if (this.#socket?.readyState === WebSocket.OPEN) this.#sendNow({ type: 'leave' })
  }

  destroy() {
    this.#stopped = true
    clearTimeout(this.#retryTimer)
    clearTimeout(this.#flushTimer)
    clearInterval(this.#pingTimer)
    this.leave()
    this.#socket?.close(1000, 'Client stopped')
  }

  #sendNow(message) {
    if (this.#socket?.readyState === WebSocket.OPEN) {
      const payload =
        typeof message === 'string' || message instanceof ArrayBuffer
          ? message
          : ArrayBuffer.isView(message)
            ? message
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

  #sendPing() {
    if (!this.#desiredRoom || this.#socket?.readyState !== WebSocket.OPEN) return
    const sentAt = performance.now()
    const message = { type: 'ping', version: 0, sentAt }
    this.#sendNow(this.#codec === 'binary' ? encodeBinary(message) : message)
  }

  #recordTraffic(direction, bytes) {
    this.#trafficEvents.push({ direction, bytes, at: performance.now() })
  }

  #flushQueue() {
    while (
      this.#queue.length &&
      this.#socket?.readyState === WebSocket.OPEN &&
      this.#socket.bufferedAmount <= MAX_BUFFERED_BYTES
    ) {
      this.#sendNow(this.#queue.shift())
    }
    if (this.#queue.length) this.#scheduleFlush()
  }

  #scheduleFlush() {
    if (this.#flushTimer || this.#stopped) return
    this.#flushTimer = setTimeout(() => {
      this.#flushTimer = null
      this.#flushQueue()
    }, 100)
  }

  #scheduleReconnect() {
    clearTimeout(this.#retryTimer)
    const wait = this.#retryDelay
    this.#retryDelay = Math.min(this.#retryDelay * 2, 10_000)
    this.#retryTimer = setTimeout(() => {
      this.#retryTimer = null
      this.connect()
    }, wait)
  }
}
