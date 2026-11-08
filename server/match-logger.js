import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { Transform, PassThrough } from "node:stream";
import { pipeline } from "node:stream";
import { once } from "node:events";
import { join } from "node:path";
import { EventEmitter } from "node:events";

export class MatchLogger extends EventEmitter {
  #source;
  #pipelineDone;
  #closed = false;

  constructor(filePath) {
    super();
    this.matchId = filePath
      .split(/[\\/]/)
      .at(-1)
      .replace(/\.ndjson$/, "");
    this.#source = new PassThrough({ objectMode: true, highWaterMark: 32 });
    const toNdjson = new Transform({
      writableObjectMode: true,
      transform(event, _encoding, callback) {
        callback(null, `${JSON.stringify(event)}\n`);
      },
    });
    const destination = createWriteStream(filePath, {
      flags: "a",
      highWaterMark: 16 * 1024,
    });
    this.#pipelineDone = new Promise((resolve, reject) => {
      pipeline(this.#source, toNdjson, destination, (error) => {
        if (error) {
          this.emit("error", error);
          reject(error);
        } else {
          resolve();
        }
      });
    });
    this.#pipelineDone.catch(() => {});
  }

  async append(event) {
    if (this.#closed) throw new Error("Cannot append to a closed match log");
    if (!this.#source.write({ ...event, matchId: this.matchId })) {
      await once(this.#source, "drain");
    }
  }

  async close() {
    if (this.#closed) return this.#pipelineDone;
    this.#closed = true;
    this.#source.end();
    await this.#pipelineDone;
  }
}

export class MatchLogManager {
  #directory;
  #logs = new Map();

  constructor(directory) {
    this.#directory = directory;
  }

  async open(roomId) {
    await mkdir(this.#directory, { recursive: true });
    const matchId = `${roomId}-${Date.now()}-${randomUUID().slice(0, 8)}`;
    const logger = new MatchLogger(join(this.#directory, `${matchId}.ndjson`));
    logger.on("error", (error) =>
      console.error(`Match log ${matchId}:`, error),
    );
    this.#logs.set(matchId, logger);
    return logger;
  }

  get(matchId) {
    return this.#logs.get(matchId);
  }

  async close() {
    const results = await Promise.allSettled(
      [...this.#logs.values()].map((log) => log.close()),
    );
    const failures = results.filter((result) => result.status === "rejected");
    if (failures.length)
      throw new AggregateError(
        failures.map((result) => result.reason),
        "Failed to close match logs",
      );
  }
}
