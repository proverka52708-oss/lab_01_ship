import { z } from "zod";
import {
  InputCommandSchema,
  type InputCommand,
  type InputSeq,
  type SimulationTick,
} from "./types.ts";

export { parseClientMessage } from "./types.ts";
export type { ClientMessage } from "./types.ts";
export {
  GameSnapshotSchema,
  SnapshotAckSchema,
  SnapshotEntitySchema,
} from "./types.ts";

export const CONTROL_PROTOCOL_VERSION = 0;
export const BINARY_PROTOCOL_VERSION = 1;
export const CLIENT_MESSAGE_TYPES = Object.freeze([
  "join",
  "chat",
  "input",
  "ping",
]);
export const MESSAGE_KIND = Object.freeze({
  input: 1,
  snapshot: 2,
  ping: 3,
  pong: 4,
});

export const InputCommandRuntimeSchema = InputCommandSchema;

export function validateInputCommand(command: unknown): InputCommand {
  if (!isRecord(command)) {
    throw new TypeError("Input command must be an object.");
  }
  if (
    !Number.isSafeInteger(command.seq) ||
    typeof command.seq !== "number" ||
    command.seq < 1 ||
    command.seq > 0xffffffff
  ) {
    throw new RangeError(
      "Input sequence must be an unsigned 32-bit integer above zero.",
    );
  }
  if (
    typeof command.tick !== "number" ||
    !Number.isSafeInteger(command.tick) ||
    command.tick < 0 ||
    command.tick > 0xffffffff
  ) {
    throw new RangeError("Input tick must be an unsigned 32-bit integer.");
  }
  if (
    typeof command.turn !== "number" ||
    !Number.isInteger(command.turn) ||
    command.turn < -1 ||
    command.turn > 1
  ) {
    throw new RangeError("Input turn must be -1, 0, or 1.");
  }
  if (
    typeof command.thrust !== "boolean" ||
    typeof command.brake !== "boolean" ||
    typeof command.fire !== "boolean"
  ) {
    throw new TypeError(
      "Input thrust, brake, and fire flags must be booleans.",
    );
  }
  if (Object.keys(command).some((key) => !INPUT_FIELDS.includes(key))) {
    throw new TypeError("Input command contains unsupported fields.");
  }
  return InputCommandSchema.parse(command);
}

const INPUT_FIELDS = ["seq", "tick", "turn", "thrust", "brake", "fire"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export interface KeyboardState {
  isDown(code: string): boolean;
}

export function inputToKeyboard(command: InputCommand): KeyboardState {
  return {
    isDown(code: string): boolean {
      if (code === "ArrowLeft" || code === "KeyA") return command.turn < 0;
      if (code === "ArrowRight" || code === "KeyD") return command.turn > 0;
      if (code === "ArrowUp" || code === "KeyW") return command.thrust;
      if (code === "Space") return command.brake;
      if (code === "KeyF") return command.fire;
      return false;
    },
  };
}

export type WireInputFields = {
  readonly seq: InputSeq | number;
  readonly tick: SimulationTick | number;
  readonly turn: number;
  readonly thrust: boolean;
  readonly brake: boolean;
  readonly fire: boolean;
};

export const NonNegativeFiniteNumberSchema = z.number().finite().nonnegative();
