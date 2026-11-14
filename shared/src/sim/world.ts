import { Asteroid } from "./asteroid.ts";
import { Bullet, type BulletOptions } from "./bullet.ts";
import { collisionPairs, resolveCollisions } from "./collision.ts";
import { Explosion } from "./explosion.ts";
import { Pickup } from "./pickup.ts";
import { Ship } from "./ship.ts";
import { Vector2 } from "./vector.ts";
import { mulberry32 } from "../prng.ts";
import type { RandomSource } from "../prng.ts";
import type { CollisionEvent, CollisionPair } from "./collision.ts";
import type {
  EntityKind,
  EntitySnapshot,
  InputState,
  PickupEffect,
  WorldSnapshot,
} from "./snapshot-types.ts";

export type WorldEntity = Asteroid | Bullet | Explosion | Pickup | Ship;

interface WorldOptions {
  readonly width?: number;
  readonly height?: number;
  readonly seed?: number;
  readonly collisionSystem?: (world: World) => Iterable<CollisionPair>;
  readonly emit?: (event: string, payload: unknown) => void;
}

type WorldInput = InputState | Map<string, InputState>;

const NO_INPUT = Object.freeze({ isDown: () => false });

export class World {
  #entities = new Map<number, WorldEntity>();
  #pendingRemoval = new Set<number>();
  #bulletPool: Bullet[] = [];
  #explosionPool: Explosion[] = [];
  #poolHits = 0;
  #poolMisses = 0;
  #random: RandomSource;
  #seed: number;
  #nextEntityId = 1;
  #collisionSystem: (world: World) => Iterable<CollisionPair>;
  width: number;
  height: number;
  emit: (event: string, payload: unknown) => void;

  constructor({
    width = 800,
    height = 600,
    seed = 2025,
    collisionSystem = collisionPairs,
    emit = () => {},
  }: WorldOptions = {}) {
    if (width <= 0 || height <= 0) {
      throw new RangeError("World width and height must be positive.");
    }
    this.width = width;
    this.height = height;
    this.#seed = seed >>> 0;
    this.#random = mulberry32(seed);
    this.#collisionSystem = collisionSystem;
    this.emit = emit;
  }

  get size() {
    return this.#entities.size;
  }

  get poolStats() {
    return {
      hits: this.#poolHits,
      misses: this.#poolMisses,
      availableBullets: this.#bulletPool.length,
      availableExplosions: this.#explosionPool.length,
    };
  }

  spawn<T extends WorldEntity>(entity: T): T {
    if (!entity || typeof entity.assignId !== "function") {
      throw new TypeError("World.spawn expects an Entity with an integer id.");
    }
    if (!entity.idWasRestored) {
      entity.assignId(this.#nextEntityId);
    }
    if (this.#entities.has(entity.id)) {
      throw new Error(`Entity ${entity.id} is already in this world.`);
    }
    this.#nextEntityId = Math.max(this.#nextEntityId, entity.id + 1);
    entity.idWasRestored = false;
    entity.alive = true;
    this.#entities.set(entity.id, entity);
    return entity;
  }

  despawn(id: number): boolean {
    const entity = this.#entities.get(id);
    if (!entity) {
      return false;
    }
    entity.alive = false;
    this.#pendingRemoval.add(id);
    return true;
  }

  get(id: number): WorldEntity | undefined {
    return this.#entities.get(id);
  }

  *[Symbol.iterator](): IterableIterator<WorldEntity> {
    yield* this.#entities.values();
  }

  *ofKind(kind: EntityKind): IterableIterator<WorldEntity> {
    for (const entity of this.#entities.values()) {
      if (entity.alive && entity.kind === kind) {
        yield entity;
      }
    }
  }

  random() {
    return this.#random();
  }

  createExplosion(x: number, y: number): Explosion {
    const explosion = this.#explosionPool.pop();
    if (explosion) {
      this.#poolHits += 1;
      explosion.reset(x, y, () => this.random());
      return explosion;
    }
    this.#poolMisses += 1;
    return new Explosion(x, y, () => this.random());
  }

  createBullet(options: BulletOptions): Bullet {
    const bullet = this.#bulletPool.pop();
    if (bullet) {
      this.#poolHits += 1;
      bullet.reset(options);
      return bullet;
    }
    this.#poolMisses += 1;
    return new Bullet(options);
  }

  createPickup(x: number, y: number, effect: PickupEffect): Pickup {
    return new Pickup(x, y, effect);
  }

  safePosition(radius: number, avoidKind: EntityKind = "asteroid"): Vector2 {
    const candidates = [];
    for (let attempt = 0; attempt < 48; attempt += 1) {
      const point = new Vector2(
        this.random() * this.width,
        this.random() * this.height,
      );
      const safe = [...this.ofKind(avoidKind)].every((entity) => {
        const distance = entity.pos.sub(point).length();
        return distance >= entity.radius + radius + 48;
      });
      if (safe) {
        return point;
      }
      candidates.push(point);
    }

    let safest = new Vector2(this.width / 2, this.height / 2);
    let greatestClearance = -Infinity;
    for (const point of candidates) {
      const clearance = [...this.ofKind(avoidKind)].reduce(
        (minimum, entity) =>
          Math.min(
            minimum,
            entity.pos.sub(point).length() - entity.radius - radius,
          ),
        Infinity,
      );
      if (clearance > greatestClearance) {
        safest = point;
        greatestClearance = clearance;
      }
    }
    return safest;
  }

  resize(width: number, height: number): void {
    if (width <= 0 || height <= 0) {
      throw new RangeError("World width and height must be positive.");
    }
    this.width = width;
    this.height = height;
    for (const entity of this.#entities.values()) {
      if (
        entity.kind === "ship" ||
        entity.kind === "bullet" ||
        entity.kind === "pickup"
      ) {
        entity.pos.set(
          ((entity.pos.x % width) + width) % width,
          ((entity.pos.y % height) + height) % height,
        );
      }
    }
  }

  step(dt: number, inputs: WorldInput = NO_INPUT): CollisionEvent[] {
    if (!Number.isFinite(dt) || dt < 0) {
      throw new RangeError("dt must be a non-negative finite number.");
    }

    // A snapshot keeps entities spawned during this step from updating until the next step.
    const entitiesAtStepStart = [...this.#entities.values()];
    for (const entity of entitiesAtStepStart) {
      if (entity.alive) {
        entity.update(dt, inputs, this);
      }
    }

    const events = resolveCollisions(this, this.#collisionSystem(this));
    for (const entity of this.#entities.values()) {
      if (!entity.alive) {
        this.#pendingRemoval.add(entity.id);
      }
    }
    for (const id of this.#pendingRemoval) {
      const removed = this.#entities.get(id);
      this.#entities.delete(id);
      if (removed instanceof Bullet && this.#bulletPool.length < 256) {
        this.#bulletPool.push(removed);
      } else if (removed instanceof Explosion && this.#explosionPool.length < 64) {
        this.#explosionPool.push(removed);
      }
    }
    this.#pendingRemoval.clear();
    return events;
  }

  addAsteroid(
    x: number,
    y: number,
    options: ConstructorParameters<typeof Asteroid>[2] = {},
  ): Asteroid {
    return this.spawn(new Asteroid(x, y, options));
  }

  toSnapshot(): WorldSnapshot {
    return {
      width: this.width,
      height: this.height,
      seed: this.#seed,
      randomState: this.#random.getState(),
      nextEntityId: this.#nextEntityId,
      entities: [...this.#entities.values()].map((entity) =>
        entity.toSnapshot(),
      ),
    };
  }

  static fromSnapshot(
    snapshot: WorldSnapshot,
    options: Omit<WorldOptions, "width" | "height" | "seed"> = {},
  ): World {
    if (
      !snapshot ||
      !Number.isInteger(snapshot.width) ||
      !Number.isInteger(snapshot.height) ||
      !Number.isInteger(snapshot.seed) ||
      !Number.isInteger(snapshot.randomState) ||
      !isEntitySnapshotArray(snapshot.entities)
    ) {
      throw new TypeError("World snapshot is invalid.");
    }
    const world = new World({
      width: snapshot.width,
      height: snapshot.height,
      seed: snapshot.seed,
      ...options,
    });
    world.#random.setState(snapshot.randomState);
    for (const data of snapshot.entities) {
      switch (data.kind) {
        case "ship":
          world.spawn(Ship.fromSnapshot(data));
          break;
        case "asteroid":
          world.spawn(Asteroid.fromSnapshot(data));
          break;
        case "bullet":
          world.spawn(Bullet.fromSnapshot(data));
          break;
        case "pickup":
          world.spawn(Pickup.fromSnapshot(data));
          break;
        case "explosion":
          world.spawn(Explosion.fromSnapshot(data));
          break;
        default:
          assertNever(data);
      }
    }
    world.#nextEntityId = Math.max(
      world.#nextEntityId,
      snapshot.nextEntityId ?? 1,
    );
    return world;
  }
}

function assertNever(value: never): never {
  throw new TypeError(
    `World snapshot contains an unsupported entity: ${String(value)}`,
  );
}

function isEntitySnapshotArray(
  value: unknown,
): value is readonly EntitySnapshot[] {
  return Array.isArray(value);
}
