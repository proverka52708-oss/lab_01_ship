import { monitorEventLoopDelay, performance } from "node:perf_hooks";

export interface GameMetrics {
  rooms: number;
  activePlayers: number;
  averageStepMs: number;
}

export class ServerMetrics {
  #messages = 0;
  #bytes = 0;
  #lastMessages = 0;
  #lastBytes = 0;
  #messagesPerSecond = 0;
  #bytesPerSecond = 0;
  #sampledAt = performance.now();
  #eventLoopUtilization = 0;
  #previousEventLoopUtilization = performance.eventLoopUtilization();
  #eventLoopDelay = monitorEventLoopDelay({ resolution: 20 });
  #connections = 0;
  #sampleTimer: ReturnType<typeof setInterval>;

  constructor() {
    this.#eventLoopDelay.enable();
    this.#sampleTimer = setInterval(() => this.#sample(), 1000);
    this.#sampleTimer.unref();
  }

  recordMessage(bytes: number): void {
    this.#messages += 1;
    this.#bytes += bytes;
  }

  setConnections(count: number): void {
    this.#connections = count;
  }

  snapshot(game: GameMetrics) {
    return {
      rooms: game.rooms,
      players: game.activePlayers,
      connections: this.#connections,
      messagesPerSecond: this.#messagesPerSecond,
      bytesPerSecond: this.#bytesPerSecond,
      averageStepMs: game.averageStepMs,
      eventLoopUtilization: this.#eventLoopUtilization,
      eventLoopDelayP95Ms: this.#eventLoopDelay.percentile(95) / 1e6,
      memoryBytes: process.memoryUsage(),
    };
  }

  close(): void {
    clearInterval(this.#sampleTimer);
    this.#eventLoopDelay.disable();
  }

  #sample(): void {
    const now = performance.now();
    const elapsedSeconds = Math.max((now - this.#sampledAt) / 1000, 0.001);
    this.#messagesPerSecond =
      (this.#messages - this.#lastMessages) / elapsedSeconds;
    this.#bytesPerSecond = (this.#bytes - this.#lastBytes) / elapsedSeconds;
    this.#lastMessages = this.#messages;
    this.#lastBytes = this.#bytes;
    this.#sampledAt = now;
    this.#eventLoopUtilization = performance.eventLoopUtilization(
      this.#previousEventLoopUtilization,
    ).utilization;
    this.#previousEventLoopUtilization = performance.eventLoopUtilization();
    this.#eventLoopDelay.reset();
  }
}
