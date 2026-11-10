import { performance } from "node:perf_hooks";
import {
  decodeBinary,
  decodeJson,
  encodeBinary,
  encodeJson,
  measureJsonBytes,
} from "@dogfight/shared/codec";

const ENTITY_COUNT = 24;
const ACK_COUNT = 4;
const ITERATIONS = 10_000;

const snapshot = {
  type: "snapshot",
  tick: 90_000,
  acks: Array.from({ length: ACK_COUNT }, (_, index) => ({
    entityId: index + 1,
    seq: 2_500,
  })),
  entities: Array.from({ length: ENTITY_COUNT }, (_, index) => ({
    id: index + 1,
    kind: index < ACK_COUNT ? "ship" : index < 18 ? "asteroid" : "bullet",
    x: (index * 37.125) % 960,
    y: (index * 19.875) % 600,
    vx: 42.125 - index,
    vy: -11.75 + index,
    angle: -Math.PI + index * 0.17,
    radius: index < ACK_COUNT ? 13 : 20,
    hp: index < ACK_COUNT ? 3 : 1,
    thrust: index % 2,
    invulnerableTime: index < ACK_COUNT ? 0.25 : 0,
    shield: index === 0,
    ownerId: index >= 18 ? 1 : 0,
    ttl: index >= 18 ? 1.4 : 0,
    commandSeq: index >= 18 ? index * 3 : 0,
    score: index < ACK_COUNT ? index * 100 : 0,
  })),
};
const jsonSnapshot = { version: 0, ...snapshot };
const jsonBytes = measureJsonBytes(jsonSnapshot);
const binaryBytes = encodeBinary(snapshot).byteLength;
const jsonData = encodeJson(jsonSnapshot);
const binaryData = encodeBinary(snapshot);

function measure(operation: () => void): number {
  const started = performance.now();
  for (let index = 0; index < ITERATIONS; index += 1) operation();
  return ((performance.now() - started) * 1_000) / ITERATIONS;
}

const jsonEncodeDecodeUs = measure(() => {
  decodeJson(jsonData);
  encodeJson(jsonSnapshot);
});
const binaryEncodeDecodeUs = measure(() => {
  decodeBinary(binaryData);
  encodeBinary(snapshot);
});

console.log(
  JSON.stringify(
    {
      runtime: process.version,
      entities: ENTITY_COUNT,
      acknowledgements: ACK_COUNT,
      iterations: ITERATIONS,
      snapshot: {
        jsonBytes,
        binaryBytes,
        jsonDownKBpsAt30Hz: Number(((jsonBytes * 30) / 1024).toFixed(2)),
        binaryDownKBpsAt30Hz: Number(((binaryBytes * 30) / 1024).toFixed(2)),
      },
      encodeDecodeMicrosecondsPerSnapshot: {
        json: Number(jsonEncodeDecodeUs.toFixed(2)),
        binary: Number(binaryEncodeDecodeUs.toFixed(2)),
      },
    },
    null,
    2,
  ),
);
