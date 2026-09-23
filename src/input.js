export function createInput(target = window) {
  const down = new Set()
  const pressed = new Set()

  function handleKeyDown(event) {
    if (!down.has(event.code)) pressed.add(event.code)
    down.add(event.code)
  }

  function handleKeyUp(event) {
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
