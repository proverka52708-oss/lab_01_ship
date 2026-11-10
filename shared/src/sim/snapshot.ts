import { World } from "./world.ts";
import type { WorldSnapshot } from "./snapshot-types.ts";

export function createSnapshot(world: World): WorldSnapshot {
  if (!(world instanceof World)) {
    throw new TypeError("createSnapshot expects a World.");
  }
  return structuredClone(world.toSnapshot());
}

export function restoreSnapshot(
  snapshot: WorldSnapshot,
  options: Parameters<typeof World.fromSnapshot>[1] = {},
): World {
  return World.fromSnapshot(structuredClone(snapshot), options);
}
