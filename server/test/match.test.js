import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { Match } from "../match.js";

function createHarness(roomId = "test-room") {
  let now = 0;
  const scheduled = [];
  const room = new EventEmitter();
  room.id = roomId;
  room.arena = "standard";
  const match = new Match(room, {
    now: () => now,
    schedule(callback, delay) {
      scheduled.push({ callback, delay });
      return scheduled.length;
    },
    cancel() {},
  });
  return {
    room,
    match,
    scheduled,
    advance(milliseconds) {
      now += milliseconds;
      scheduled.shift()?.callback();
    },
  };
}

test("match is deterministic and schedules authoritative snapshots at 30 Hz", () => {
  const first = createHarness();
  const second = createHarness();
  assert.deepEqual(first.match.world.toSnapshot(), second.match.world.toSnapshot());

  const player = { id: "pilot-1", name: "Pilot" };
  first.room.emit("join", { player });
  const snapshots = [];
  first.room.on("snapshot", (snapshot) => snapshots.push(snapshot));

  assert.equal(first.scheduled[0].delay, 1000 / 30);
  first.advance(1000 / 30);
  assert.equal(first.match.tick, 1);
  assert.equal(snapshots[0].tick, 1);
  assert.equal(snapshots[0].entities.some((entity) => entity.id === player.entityId), true);

  first.match.stop();
  second.match.stop();
});

test("match accepts sequenced input only and acknowledges processed commands", () => {
  const { room, match, advance } = createHarness();
  const player = { id: "pilot-1", name: "Pilot" };
  room.emit("join", { player });
  const snapshots = [];
  room.on("snapshot", (snapshot) => snapshots.push(snapshot));

  assert.equal(
    match.enqueueInput(player.id, {
      seq: 1,
      tick: 1,
      turn: 1,
      thrust: true,
      brake: false,
      fire: false,
    }),
    true,
  );
  assert.throws(
    () =>
      match.enqueueInput(player.id, {
        seq: 1,
        tick: 2,
        turn: 0,
        thrust: false,
        brake: false,
        fire: false,
      }),
    /sequence/,
  );
  assert.throws(
    () =>
      match.enqueueInput(player.id, {
        seq: 2,
        tick: 2,
        x: 100,
        y: 200,
        turn: 0,
        thrust: false,
        brake: false,
        fire: false,
      }),
    /unsupported fields/,
  );

  advance(1000 / 30);
  assert.equal(snapshots.at(-1).acks[0].seq, 1);
  match.stop();
});
