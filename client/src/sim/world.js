export class World {
  #entities = new Map()

  get size() {
    return this.#entities.size
  }

  spawn(entity) {
    if (this.#entities.has(entity.id)) {
      throw new Error(`Entity ${entity.id} is already in the world`)
    }

    this.#entities.set(entity.id, entity)
    return entity
  }

  despawn(id) {
    const entity = this.#entities.get(id)
    if (!entity) return false

    entity.alive = false
    return true
  }

  get(id) {
    return this.#entities.get(id)
  }

  *[Symbol.iterator]() {
    yield* this.#entities.values()
  }

  *ofKind(kind) {
    for (const entity of this) {
      if (entity.alive && entity.kind === kind) yield entity
    }
  }

  step(dt, inputs) {
    for (const entity of this) {
      if (entity.alive) entity.update(dt, inputs)
    }

    for (const [id, entity] of this.#entities) {
      if (!entity.alive) this.#entities.delete(id)
    }
  }
}
