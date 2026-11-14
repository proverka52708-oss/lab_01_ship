import assert from "node:assert/strict";
import fc from "fast-check";
import { test, describe } from "vitest";
import { BINARY_PACKET_SPEC, decodeBinary, encodeBinary } from "../src/codec.ts";
import { circlesOverlap } from "../src/sim/collision.ts";
import { Asteroid } from "../src/sim/asteroid.ts";
import { Ship, integrate } from "../src/sim/ship.ts";
import { Vector2 } from "../src/sim/vector.ts";
import { World } from "../src/sim/world.ts";
import { wrapShip } from "../src/sim/arena.ts";
import { parseClientMessage } from "../src/protocol.ts";

describe("simulation properties", () => {
  test.each([
    [0, 0],
    [12, 4],
    [-12, 4],
    [12, -4],
    [-12, -4],
    [0.25, -0.75],
  ])("Vector2 normalizes finite input (%s, %s)", (x, y) => {
    const vector = new Vector2(x, y);
    const normalized = vector.normalize();
    assert.ok(Number.isFinite(normalized.x));
    assert.ok(Number.isFinite(normalized.y));
    if (x === 0 && y === 0) {
      assert.deepEqual(normalized, new Vector2());
    } else {
      assert.ok(Math.abs(normalized.length() - 1) < 1e-12);
    }
  });

  test.each([
    [0, 0, 1],
    [2, 0, 3],
    [0, 3, 2],
    [2, 2, 2],
    [1, 0, 1],
    [1, 0, 1.01],
  ])("circle collision handles boundary distance", (x, y, radius) => {
    const ship = new Ship(0, 0, { invulnerableTime: 0 });
    const asteroid = new Asteroid(x, y, { radius, hp: 1 });
    assert.equal(circlesOverlap(ship, asteroid), Math.hypot(x, y) <= 13 + radius);
  });

  test.each([
    [-2, 0, 100, 80],
    [102, 40, 100, 80],
    [50, -3, 100, 80],
    [30, 82, 100, 80],
    [250, 180, 100, 80],
  ])("arena wrapping always returns in-bounds coordinates", (x, y, width, height) => {
    const wrapped = wrapShip({ x, y, id: "pilot" }, width, height);
    assert.ok(wrapped.x >= 0 && wrapped.x < width);
    assert.ok(wrapped.y >= 0 && wrapped.y < height);
    assert.equal(wrapped.id, "pilot");
  });

  test.each([
    { turn: 0, thrust: false, brake: false },
    { turn: 1, thrust: false, brake: false },
    { turn: -1, thrust: true, brake: false },
    { turn: 0, thrust: true, brake: true },
    { turn: 1, thrust: true, brake: true },
  ])("integration keeps finite state for input %j", (input) => {
    const state = integrate(
      { x: 25, y: 40, vx: 10, vy: -8, angle: -Math.PI / 2 },
      { isDown: (code) =>
        (code === "ArrowRight" && input.turn > 0) ||
        (code === "ArrowLeft" && input.turn < 0) ||
        (code === "ArrowUp" && input.thrust) ||
        (code === "Space" && input.brake),
      },
      1 / 60,
    );
    for (const value of Object.values(state)) assert.ok(Number.isFinite(value));
    assert.ok(Math.hypot(state.vx, state.vy) <= 320);
  });
});

test("binary codec properties", () => {
  fc.assert(
    fc.property(
      fc.record({
        seq: fc.integer({ min: 1, max: 0xffffffff }),
        tick: fc.integer({ min: 0, max: 0xffffffff }),
        turn: fc.constantFrom(-1, 0, 1),
        thrust: fc.boolean(),
        brake: fc.boolean(),
        fire: fc.boolean(),
      }),
      (input) => {
        const message = { type: "input", ...input };
        assert.deepEqual(decodeBinary(encodeBinary(message)), message);
      },
    ),
    { numRuns: 100 },
  );

  fc.assert(
    fc.property(fc.double({ min: -Math.PI, max: Math.PI, noNaN: true }), (angle) => {
      const packet = encodeBinary({
        type: "snapshot",
        tick: 4,
        acks: [],
        entities: [
          {
            id: 1,
            kind: "ship",
            x: 1,
            y: 2,
            vx: 3,
            vy: 4,
            angle,
            radius: 13,
          },
        ],
      });
      const decoded = decodeBinary(packet);
      if (decoded.type !== "snapshot") throw new TypeError("Expected snapshot.");
      const decodedAngle = decoded.entities[0]?.angle;
      if (typeof decodedAngle !== "number") {
        throw new TypeError("Decoded snapshot entity has no angle.");
      }
      const difference = Math.atan2(
        Math.sin(decodedAngle - angle),
        Math.cos(decodedAngle - angle),
      );
      assert.ok(Math.abs(difference) <= 0.000051);
    }),
    { numRuns: 100 },
  );

  fc.assert(
    fc.property(
      fc.integer({ min: 0, max: 30 }),
      fc.integer({ min: 0, max: 10 }),
      (entityCount, ackCount) => {
        const entities = Array.from({ length: entityCount }, (_, index) => ({
          id: index + 1,
          kind: "ship",
          x: index,
          y: index,
          vx: 0,
          vy: 0,
          angle: 0,
          radius: 13,
        }));
        const acks = Array.from({ length: ackCount }, (_, index) => ({
          entityId: index + 1,
          seq: index + 1,
        }));
        const packet = encodeBinary({ type: "snapshot", tick: 1, entities, acks });
        assert.equal(
          packet.byteLength,
          BINARY_PACKET_SPEC.snapshotHeaderBytes +
            ackCount * BINARY_PACKET_SPEC.ackBytes +
            entityCount * BINARY_PACKET_SPEC.entityBytes,
        );
      },
    ),
    { numRuns: 100 },
  );

  fc.assert(
    fc.property(fc.uint8Array({ maxLength: 80 }), (bytes) => {
      const malformed = new Uint8Array(Math.max(bytes.length + 2, 12));
      malformed.set(bytes, 2);
      malformed[0] = 255;
      assert.throws(() => decodeBinary(malformed), /version/i);
    }),
    { numRuns: 100 },
  );
});

test("ships remain inside the arena for generated dimensions and input sequences", () => {
  fc.assert(
    fc.property(
      fc.integer({ min: 20, max: 2000 }),
      fc.integer({ min: 20, max: 2000 }),
      fc.array(
        fc.record({
          turn: fc.constantFrom(-1, 0, 1),
          thrust: fc.boolean(),
          brake: fc.boolean(),
        }),
        { minLength: 1, maxLength: 60 },
      ),
      (width, height, commands) => {
        const world = new World({ width, height, seed: 420 });
        const ship = world.spawn(new Ship(width / 2, height / 2));
        for (const command of commands) {
          world.step(1 / 30, {
            isDown: (code) =>
              (code === "ArrowRight" && command.turn > 0) ||
              (code === "ArrowLeft" && command.turn < 0) ||
              (code === "ArrowUp" && command.thrust) ||
              (code === "Space" && command.brake),
          });
          assert.ok(ship.pos.x >= 0 && ship.pos.x < width);
          assert.ok(ship.pos.y >= 0 && ship.pos.y < height);
        }
      },
    ),
    { numRuns: 60 },
  );
});

test("client-message parsing accepts valid input and rejects added fields", () => {
  fc.assert(
    fc.property(
      fc.record({
        seq: fc.integer({ min: 1, max: 0xffffffff }),
        tick: fc.integer({ min: 0, max: 0xffffffff }),
        turn: fc.constantFrom(-1, 0, 1),
        thrust: fc.boolean(),
        brake: fc.boolean(),
        fire: fc.boolean(),
      }),
      (command) => {
        const valid = { type: "input", ...command };
        assert.deepEqual(parseClientMessage(valid), valid);
        assert.throws(() => parseClientMessage({ ...valid, invalid: true }));
      },
    ),
    { numRuns: 100 },
  );
});

test("step-based ship motion matches the public integration helper", () => {
  fc.assert(
    fc.property(
      fc.double({ min: -100, max: 100, noNaN: true }),
      fc.double({ min: -100, max: 100, noNaN: true }),
      fc.double({ min: -Math.PI, max: Math.PI, noNaN: true }),
      fc.boolean(),
      (vx, vy, angle, thrust) => {
        const world = new World({ width: 1000, height: 1000 });
        const ship = world.spawn(new Ship(500, 500, { angle, invulnerableTime: 0 }));
        ship.vel.set(vx, vy);
        const expected = integrate(
          { x: 500, y: 500, vx, vy, angle },
          { isDown: (code) => code === "ArrowUp" && thrust },
          1 / 60,
        );
        world.step(1 / 60, { isDown: (code) => code === "ArrowUp" && thrust });
        assert.ok(Math.abs(ship.vel.x - expected.vx) < 1e-10);
        assert.ok(Math.abs(ship.vel.y - expected.vy) < 1e-10);
        assert.ok(Math.abs(ship.pos.x - expected.x) < 1e-10);
        assert.ok(Math.abs(ship.pos.y - expected.y) < 1e-10);
      },
    ),
    { numRuns: 100 },
  );
});

test("World keeps vector identities stable and reuses expired bullet and explosion instances", () => {
  const world = new World({ width: 800, height: 600, seed: 6 });
  const ship = world.spawn(new Ship(400, 300, { invulnerableTime: 0 }));
  const shipPosition = ship.pos;
  const shipVelocity = ship.vel;
  for (let index = 0; index < 120; index += 1) world.step(1 / 60);
  assert.equal(ship.pos, shipPosition);
  assert.equal(ship.vel, shipVelocity);

  const firstBullet = ship.fire(world);
  assert.ok(firstBullet);
  world.step(2);
  ship.weapon.cooldown = 0;
  assert.equal(ship.fire(world), firstBullet);

  const firstExplosion = world.createExplosion(50, 50);
  world.spawn(firstExplosion);
  world.step(2);
  const nextExplosion = world.createExplosion(60, 60);
  assert.equal(nextExplosion, firstExplosion);
  assert.ok(world.poolStats.hits >= 2);
});
