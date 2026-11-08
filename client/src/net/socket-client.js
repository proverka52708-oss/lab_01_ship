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
        })
      }
      this.#flushQueue()
    })

    socket.addEventListener('message', (event) => {
      let message
      try {
        message = JSON.parse(event.data)
      } catch (error) {
        this.dispatchEvent(new CustomEvent('protocol-error', { detail: error }))
        return
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
      this.dispatchEvent(new CustomEvent('message', { detail: message }))
    })

    socket.addEventListener('close', (event) => {
      if (this.#socket !== socket) return
      this.#socket = null
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

  join(roomId, playerName) {
    if (this.#pendingJoin) {
      clearTimeout(this.#pendingJoin.timer)
      this.#pendingJoin.reject(new Error('A room join is already pending'))
    }

    this.#desiredRoom = { roomId, playerName }
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
      this.#sendNow({ type: 'join', roomId, playerName })
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
    this.leave()
    this.#socket?.close(1000, 'Client stopped')
  }

  #sendNow(message) {
    if (this.#socket?.readyState === WebSocket.OPEN) {
      this.#socket.send(JSON.stringify(message))
    }
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
