import assert from "node:assert/strict";
import { describe, expect, test } from "vitest";
import { Asteroid } from "../src/sim/asteroid.ts";
import { Bullet } from "../src/sim/bullet.ts";
import {
  collisionPairs,
  circlesOverlap,
  resolveCollisions,
} from "../src/sim/collision.ts";
import { Explosion } from "../src/sim/explosion.ts";
import { GameSession, createGame } from "../src/sim/game.ts";
import { createHomingBehavior } from "../src/sim/homing.ts";
import { Pickup } from "../src/sim/pickup.ts";
import { Ship, interpolateShip } from "../src/sim/ship.ts";
import { Vector2 } from "../src/sim/vector.ts";
import { World } from "../src/sim/world.ts";

describe("Vector2", () => {
  test.each([
    [1, 2, 4, 6],
    [0, 0, 0, 0],
    [-3, 5, 2, -4],
  ])("clones, adds and subtracts vectors", (x, y, otherX, otherY) => {
    const vector = new Vector2(x, y);
    const other = new Vector2(otherX, otherY);
    expect(vector.clone()).not.toBe(vector);
    expect(vector.clone()).toEqual(vector);
    expect(vector.add(other)).toEqual(new Vector2(x + otherX, y + otherY));
    expect(vector.add(other).sub(other)).toEqual(vector);
  });

  test.each([
    [3, 4, 5],
    [0, 0, 0],
    [-5, 12, 13],
  ])("computes lengths and dot product", (x, y, length) => {
    const vector = new Vector2(x, y);
    expect(vector.length()).toBe(length);
    expect(vector.lengthSquared()).toBe(length * length);
    expect(vector.dot(new Vector2(2, 3))).toBe(x * 2 + y * 3);
  });

  test.each([
    [0, 1, 0],
    [Math.PI / 2, 0, 2],
    [Math.PI, -3, 0],
  ])("scales, rotates and creates angle vectors", (angle, x, y) => {
    const vector = new Vector2(x, y);
    expect(vector.scale(2)).toEqual(new Vector2(x * 2, y * 2));
    const rotated = vector.rotate(angle);
    expect(Number.isFinite(rotated.x)).toBe(true);
    expect(Number.isFinite(rotated.y)).toBe(true);
    const fromAngle = Vector2.fromAngle(angle, 2);
    expect(Math.abs(fromAngle.length() - 2)).toBeLessThan(1e-12);
  });

  test("mutates in place and leaves zero vectors normalized as zero", () => {
    const vector = new Vector2(2, 4);
    expect(Object.getOwnPropertyDescriptor(Vector2.prototype, "x")?.set).toBeUndefined();
    expect(Object.getOwnPropertyDescriptor(Vector2.prototype, "y")?.set).toBeUndefined();
    expect(vector.addInPlace(new Vector2(1, -2))).toBe(vector);
    expect(vector.subInPlace(new Vector2(1, 1))).toBe(vector);
    expect(vector.scaleInPlace(2)).toBe(vector);
    expect(vector).toEqual(new Vector2(4, 2));
    expect(new Vector2().normalize()).toEqual(new Vector2());
  });
});

describe("collisions and entity behavior", () => {
  test("collision pairs exclude dead, non-collidable, and distant entities", () => {
    const world = new World();
    const ship = world.spawn(new Ship(10, 10));
    const near = world.spawn(new Asteroid(10, 10, { radius: 5 }));
    const far = world.spawn(new Asteroid(300, 300));
    const decorative = world.spawn(
      new Explosion(10, 10, () => 0.5),
    );
    const dead = world.spawn(new Asteroid(10, 10));
    dead.alive = false;
    expect([...collisionPairs(world)]).toEqual([[ship, near]]);
    expect(circlesOverlap(ship, far)).toBe(false);
    expect(circlesOverlap(ship, decorative)).toBe(false);
  });

  test("bullets hit asteroids and destroying one spawns an explosion", () => {
    const world = new World({ seed: 1 });
    const asteroid = world.spawn(new Asteroid(50, 50, { radius: 20, hp: 2 }));
    const bullet = world.spawn(
      new Bullet({ pos: new Vector2(50, 50), ownerId: 99 }),
    );
    expect(resolveCollisions(world, [[bullet, asteroid]])[0]?.type).toBe(
      "asteroid-hit",
    );
    expect(bullet.alive).toBe(false);

    const finalBullet = world.spawn(
      new Bullet({ pos: new Vector2(50, 50), ownerId: 99 }),
    );
    const events = resolveCollisions(world, [[finalBullet, asteroid]]);
    expect(events[0]?.type).toBe("asteroid-destroyed");
    expect([...world.ofKind("explosion")]).toHaveLength(1);
  });

  test("bullets cannot damage their owner and can damage a ship", () => {
    const world = new World();
    const owner = world.spawn(new Ship(100, 100, { invulnerableTime: 0 }));
    const bullet = world.spawn(
      new Bullet({ pos: new Vector2(100, 100), ownerId: owner.id }),
    );
    expect(resolveCollisions(world, [[bullet, owner]])).toEqual([]);
    expect(bullet.alive).toBe(true);

    const enemy = world.spawn(new Ship(200, 200, { invulnerableTime: 0 }));
    const enemyBullet = world.spawn(
      new Bullet({ pos: new Vector2(200, 200), ownerId: owner.id }),
    );
    expect(resolveCollisions(world, [[enemyBullet, enemy]])[0]?.type).toBe(
      "ship-hit",
    );
    expect(enemy.hp).toBe(2);
  });

  test("ship destruction and direct ship-asteroid contact emit collision events", () => {
    const world = new World();
    const ship = world.spawn(new Ship(50, 50, { hp: 1, invulnerableTime: 0 }));
    const bullet = world.spawn(new Bullet({ pos: new Vector2(50, 50) }));
    expect(resolveCollisions(world, [[ship, bullet]])[0]?.type).toBe(
      "ship-destroyed",
    );
    expect([...world.ofKind("explosion")]).toHaveLength(1);

    const nextShip = world.spawn(new Ship(150, 150, { invulnerableTime: 0 }));
    const asteroid = world.spawn(new Asteroid(150, 150, { hp: 1 }));
    const events = resolveCollisions(world, [[nextShip, asteroid]]);
    expect(events.map((event) => event.type)).toContain("ship-hit");
    expect(events.map((event) => event.type)).toContain("asteroid-destroyed");
  });

  test("pickup effects apply, expire, and repair health", () => {
    const ship = new Ship(0, 0, { invulnerableTime: 0 });
    ship.takeDamage(2);
    new Pickup(0, 0, "shield", { duration: 2 }).applyTo(ship);
    expect(ship.effects.get("shield")).toBe(2);
    new Pickup(0, 0, "repair").applyTo(ship);
    expect(ship.hp).toBe(2);
    ship.update(2.1, undefined, new World());
    expect(ship.effects.has("shield")).toBe(false);

    const world = new World();
    const target = world.spawn(new Ship(0, 0, { invulnerableTime: 0 }));
    const pickup = world.spawn(new Pickup(0, 0, "rapid-fire"));
    expect(resolveCollisions(world, [[target, pickup]])[0]?.type).toBe(
      "pickup-collected",
    );
    expect(target.effects.has("rapid-fire")).toBe(true);
  });

  test("asteroids bounce at arena edges and homing turns toward a target", () => {
    const world = new World({ width: 100, height: 100 });
    world.spawn(new Ship(70, 50));
    const asteroid = world.spawn(
      new Asteroid(95, 50, {
        radius: 10,
        vel: new Vector2(20, 0),
        homing: createHomingBehavior({
          targetKind: "ship",
          turnRate: 0.1,
          maxSpeed: 30,
        }),
      }),
    );
    const previousVelocity = asteroid.vel.x;
    world.step(0.1);
    expect(asteroid.pos.x).toBeLessThanOrEqual(90);
    expect(asteroid.angle).not.toBe(0);
    expect(asteroid.vel.x).not.toBe(previousVelocity);
  });
});

describe("game session and interpolation", () => {
  test("creates a seeded session, fires pooled bullets, and resizes its world", () => {
    const session = createGame({ width: 640, height: 480, asteroidCount: 0 });
    expect(session).toBeInstanceOf(GameSession);
    expect(session.world.size).toBe(3);
    const player = session.player;
    expect(player).not.toBeNull();
    const input = { isDown: (code: string) => code === "KeyF" };
    session.step(1 / 60, input);
    expect([...session.world.ofKind("bullet")]).toHaveLength(1);
    session.resize(800, 600);
    expect(session.world.width).toBe(800);
    expect(session.world.height).toBe(600);
  });

  test("respawns a destroyed player after the configured delay", () => {
    const session = new GameSession({ asteroidCount: 0 });
    const player = session.player;
    assert.ok(player);
    player.invulnerableTime = 0;
    player.takeDamage(2);
    session.world.spawn(new Asteroid(player.pos.x, player.pos.y, { radius: 30 }));
    session.step(1 / 60, { isDown: () => false });
    expect(session.player).toBeNull();
    for (let tick = 0; tick < 121; tick += 1) {
      session.step(1 / 60, { isDown: () => false });
    }
    expect(session.player).toBeInstanceOf(Ship);
    expect(session.player?.invulnerableTime).toBeGreaterThan(0);
  });

  test("interpolates scalar fields and wraps across arena boundaries", () => {
    const interpolated = interpolateShip(
      { x: 99, y: 10, vx: 0, vy: 0, angle: Math.PI - 0.1, thrust: 0 },
      { x: 1, y: 20, vx: 10, vy: 5, angle: -Math.PI + 0.1, thrust: 1 },
      0.5,
      100,
      100,
    );
    expect(interpolated.x).toBeCloseTo(0);
    expect(interpolated.y).toBe(15);
    expect(interpolated.vx).toBe(5);
    expect(Math.abs(interpolated.angle)).toBeCloseTo(Math.PI);
  });
});
