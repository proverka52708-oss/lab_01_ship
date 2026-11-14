import { afterEach, describe, expect, it, vi } from "vitest";
import { createLoop } from "../src/loop.ts";

type Frame = (time: number) => void;

function frameHarness() {
  const callbacks: Frame[] = [];
  let nextId = 1;
  const cancel = vi.fn();
  vi.useFakeTimers();
  vi.setSystemTime(0);
  vi.stubGlobal(
    "requestAnimationFrame",
    (callback: Frame) => {
      callbacks.push(callback);
      return nextId++;
    },
  );
  vi.stubGlobal("cancelAnimationFrame", cancel);
  return {
    callbacks,
    cancel,
    nextFrame(time: number) {
      const callback = callbacks.shift();
      if (!callback) throw new Error("No animation frame is queued.");
      callback(time);
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("fixed-step game loop", () => {
  it.each([
    [16.67, 1],
    [33.34, 2],
    [50.01, 3],
  ])("executes accumulated fixed steps for %s ms", (elapsed, expectedSteps) => {
    const harness = frameHarness();
    const simulate = vi.fn();
    const loop = createLoop({ simulate, render: vi.fn() });
    loop.start();
    harness.nextFrame(1000);
    harness.nextFrame(1000 + elapsed);
    expect(simulate).toHaveBeenCalledTimes(expectedSteps);
    loop.stop();
  });

  it("caps a long tab pause at 250 ms of simulation", () => {
    const harness = frameHarness();
    const simulate = vi.fn();
    const loop = createLoop({ simulate, render: vi.fn() });
    loop.start();
    harness.nextFrame(1000);
    harness.nextFrame(2000);
    expect(simulate).toHaveBeenCalledTimes(15);
    loop.stop();
  });

  it("cancels the queued animation frame and prevents more work after stop", () => {
    const harness = frameHarness();
    const render = vi.fn();
    const loop = createLoop({ simulate: vi.fn(), render });
    loop.start();
    harness.nextFrame(1000);
    loop.stop();
    expect(harness.cancel).toHaveBeenCalledTimes(1);
    const framesBeforeStoppedCallback = render.mock.calls.length;
    harness.nextFrame(1016);
    expect(render).toHaveBeenCalledTimes(framesBeforeStoppedCallback);
  });
});
