export class GameEvents extends EventTarget {
  emit(type: string, detail: unknown = {}): void {
    this.dispatchEvent(new CustomEvent<unknown>(type, { detail }))
  }
}
