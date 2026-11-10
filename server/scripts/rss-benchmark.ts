import { setTimeout as delay } from "node:timers/promises";
import { Transform, Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";

const EVENT_COUNT = 24_000;
const SLOW_CHUNK_DELAY_MS = 30;
const THROTTLE_BYTES = 64 * 1024;
const samples = [];
const start = performance.now();
const sampler = setInterval(() => {
  samples.push({
    seconds: Number(((performance.now() - start) / 1000).toFixed(1)),
    rssMiB: Number((process.memoryUsage().rss / 1024 / 1024).toFixed(1)),
  });
}, 250);

const source = Readable.from(
  (async function* events() {
    for (let index = 0; index < EVENT_COUNT; index += 1) {
      yield {
        index,
        type: "chat",
        roomId: "rss-benchmark",
        text: "streamed event ".repeat(24),
      };
    }
  })(),
  { objectMode: true, highWaterMark: 16 },
);
const toNdjson = new Transform({
  writableObjectMode: true,
  transform(event, _encoding, callback) {
    callback(null, `${JSON.stringify(event)}\n`);
  },
});
let bytes = 0;
let bytesSinceThrottle = 0;
const slowDownload = new Writable({
  highWaterMark: 16 * 1024,
  write(chunk, _encoding, callback) {
    bytes += chunk.length;
    bytesSinceThrottle += chunk.length;
    if (bytesSinceThrottle < THROTTLE_BYTES) {
      callback();
      return;
    }
    bytesSinceThrottle = 0;
    delay(SLOW_CHUNK_DELAY_MS).then(() => callback(), callback);
  },
});

try {
  await pipeline(source, toNdjson, slowDownload);
} finally {
  clearInterval(sampler);
}

samples.push({
  seconds: Number(((performance.now() - start) / 1000).toFixed(1)),
  rssMiB: Number((process.memoryUsage().rss / 1024 / 1024).toFixed(1)),
});
console.log(
  JSON.stringify(
    {
      streamedMiB: Number((bytes / 1024 / 1024).toFixed(1)),
      durationSeconds: Number(((performance.now() - start) / 1000).toFixed(1)),
      samples,
    },
    null,
    2,
  ),
);
