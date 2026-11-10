export interface Input {
  isDown(code: string): boolean
  justPressed(code: string): boolean
  endFrame(): void
  destroy(): void
}

export function createInput(target: Window = window): Input {
  const down = new Set<string>()
  const pressed = new Set<string>()

  function handleKeyDown(event: KeyboardEvent): void {
    if (!down.has(event.code)) pressed.add(event.code)
    down.add(event.code)
  }

  function handleKeyUp(event: KeyboardEvent): void {
    down.delete(event.code)
  }

  target.addEventListener('keydown', handleKeyDown)
  target.addEventListener('keyup', handleKeyUp)

  return {
    isDown: (code) => down.has(code),
    justPressed: (code) => pressed.has(code),
    endFrame: () => pressed.clear(),
    destroy: () => {
      target.removeEventListener('keydown', handleKeyDown)
      target.removeEventListener('keyup', handleKeyUp)
    },
  }
}
