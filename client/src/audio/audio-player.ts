import type { GameEvents } from './game-events.ts'

type SoundName = 'shoot' | 'hit' | 'exploded'
type GameEventName = 'fired' | 'hit' | 'exploded'

const SOUND_BY_EVENT: Record<GameEventName, SoundName> = {
  fired: 'shoot',
  hit: 'hit',
  exploded: 'exploded',
}

export function createAudioPlayer(
  context: AudioContext,
  buffers: Partial<Record<SoundName, AudioBuffer | null>>,
  events: GameEvents,
): { unlock(): Promise<void>; destroy(): void } {
  const listeners: [string, EventListener][] = []

  function listen(eventName: GameEventName, soundName: SoundName): void {
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

  const soundEvents: [GameEventName, SoundName][] = [
    ['fired', SOUND_BY_EVENT.fired],
    ['hit', SOUND_BY_EVENT.hit],
    ['exploded', SOUND_BY_EVENT.exploded],
  ]
  for (const [eventName, soundName] of soundEvents) {
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
