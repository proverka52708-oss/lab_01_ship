const SOUND_BY_EVENT = {
  fired: 'shoot',
  hit: 'hit',
  exploded: 'exploded',
}

export function createAudioPlayer(context, buffers, events) {
  const listeners = []

  function listen(eventName, soundName) {
    const handler = () => {
      if (context.state !== 'running') return
      const buffer = buffers[soundName]
      if (!buffer) return
      const source = context.createBufferSource()
      source.buffer = buffer
      source.connect(context.destination)
      source.start()
    }
    events.addEventListener(eventName, handler)
    listeners.push([eventName, handler])
  }

  for (const [eventName, soundName] of Object.entries(SOUND_BY_EVENT)) {
    listen(eventName, soundName)
  }

  return {
    async unlock() {
      if (context.state !== 'running') await context.resume()
    },
    destroy() {
      for (const [eventName, handler] of listeners) {
        events.removeEventListener(eventName, handler)
      }
    },
  }
}
