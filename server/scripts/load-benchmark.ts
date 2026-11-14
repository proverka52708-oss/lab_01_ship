import { once } from "node:events";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PerformanceObserver, performance } from "node:perf_hooks";
import {
  chromium,
  type Browser,
  type CDPSession,
  type Page,
} from "@playwright/test";
import WebSocket, { type RawData } from "ws";
import { z } from "zod";
import { createApplication } from "../http-server.ts";

const CLIENT_LEVELS: readonly number[] = [8, 32, 64, 128];
const ROOM_COUNT = 8;
const INPUT_INTERVAL_MS = 55;
const MEASUREMENT_MS = 3000;
const EIGHT_BOT_RECORDING_MS = 30_000;

declare global {
  interface Window {
    __labFrameTimes: Float64Array;
    __labFrameCount: number;
    __labLongFrames: number;
    __labInlineBotCount: number;
    __labInlineBotSockets: Array<{ close(): void }>;
    __labInlineBotTimers: number[];
  }

  interface Performance {
    readonly memory?: { usedJSHeapSize: number };
  }
}

const garbageCollectionDurations: number[] = [];
const garbageCollectionObserver = new PerformanceObserver((list) => {
  for (const entry of list.getEntries()) {
    garbageCollectionDurations.push(entry.duration);
  }
});
garbageCollectionObserver.observe({ entryTypes: ["gc"] });

const StatsResponseSchema = z.object({
  matches: z.array(
    z.object({
      players: z.number(),
      lastTickDurationMs: z.number(),
      averageTickDurationMs: z.number(),
      poolStats: z.object({ hits: z.number(), misses: z.number() }),
    }),
  ),
});

interface LoadResult {
  clients: number;
  samples: number;
  tickDurationMs: {
    p50: number;
    p95: number;
    p99: number;
    max: number;
    over33ms: number;
  };
  aggregateAverageStepMs: number;
  transientObjectPool: { reuseHits: number; allocationMisses: number };
  garbageCollectionMs: { count: number; total: number; max: number };
  browserFrames?: {
    samples: number;
    p50: number;
    p95: number;
    p99: number;
    longFrames: number;
    maxHeapDeltaBytes: number | null;
  };
  browserInlineFrames?: {
    samples: number;
    p50: number;
    p95: number;
    p99: number;
    longFrames: number;
  };
}

interface V8ProfileNode {
  id: number;
  functionName: string;
  children: number[];
}

interface V8CpuProfile {
  nodes: V8ProfileNode[];
  samples: number[];
}

function percentile(samples: number[], fraction: number): number {
  if (samples.length === 0) return 0;
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)] ?? 0;
}

function parseCpuProfile(value: unknown): V8CpuProfile {
  if (!isRecord(value) || !isRecord(value.profile)) {
    throw new TypeError("Chrome DevTools returned an invalid CPU profile.");
  }
  const rawNodes = value.profile.nodes;
  const rawSamples = value.profile.samples;
  if (!Array.isArray(rawNodes) || !Array.isArray(rawSamples)) {
    throw new TypeError("Chrome DevTools CPU profile is missing nodes or samples.");
  }
  const nodes: V8ProfileNode[] = [];
  for (const rawNode of rawNodes) {
    if (
      !isRecord(rawNode) ||
      typeof rawNode.id !== "number" ||
      !isRecord(rawNode.callFrame) ||
      typeof rawNode.callFrame.functionName !== "string" ||
      (rawNode.children !== undefined &&
        (!Array.isArray(rawNode.children) ||
          !rawNode.children.every((child) => typeof child === "number")))
    ) {
      throw new TypeError("Chrome DevTools CPU profile contains an invalid node.");
    }
    nodes.push({
      id: rawNode.id,
      functionName: rawNode.callFrame.functionName || "(anonymous)",
      children: rawNode.children ?? [],
    });
  }
  if (!rawSamples.every((sample) => typeof sample === "number")) {
    throw new TypeError("Chrome DevTools CPU profile contains an invalid sample.");
  }
  return { nodes, samples: rawSamples };
}

async function writeCpuFlameChart(
  path: string,
  profileValue: unknown,
  title: string,
): Promise<void> {
  const profile = parseCpuProfile(profileValue);
  const nodeById = new Map(profile.nodes.map((node) => [node.id, node]));
  const parentById = new Map<number, number>();
  for (const node of profile.nodes) {
    for (const child of node.children) parentById.set(child, node.id);
  }
  const bucketSize = Math.max(1, Math.floor(profile.samples.length / 1200));
  const sampleStacks: Array<{ stack: number[]; weight: number }> = [];
  for (
    let index = 0;
    index < profile.samples.length;
    index += bucketSize
  ) {
    const sample = profile.samples[index];
    if (sample === undefined) continue;
    const stack: number[] = [];
    let current: number | undefined = sample;
    while (current !== undefined) {
      stack.push(current);
      current = parentById.get(current);
    }
    sampleStacks.push({
      stack: stack.reverse(),
      weight: Math.min(bucketSize, profile.samples.length - index),
    });
  }

  const chartWidth = 1200;
  const left = 40;
  const graphWidth = 1120;
  const maximumDepth = Math.max(1, ...sampleStacks.map(({ stack }) => stack.length));
  const chartHeight = maximumDepth * 20 + 70;
  const totalWeight = Math.max(1, profile.samples.length);
  const bars: string[] = [];
  let cumulativeByDepth: number[] = Array.from(
    { length: maximumDepth },
    () => 0,
  );
  for (let depth = 0; depth < maximumDepth; depth += 1) {
    let activeNode: number | undefined;
    let activeStart = 0;
    let activeWeight = 0;
    const flush = () => {
      if (activeNode === undefined || activeWeight === 0) return;
      const node = nodeById.get(activeNode);
      const x = left + (activeStart / totalWeight) * graphWidth;
      const width = (activeWeight / totalWeight) * graphWidth;
      const y = chartHeight - 38 - (depth + 1) * 20;
      const name = node?.functionName ?? "(native)";
      const color = (activeNode * 47) % 360;
      const safeName = name.replaceAll("&", "&amp;").replaceAll("<", "&lt;");
      bars.push(
        `<g><title>${safeName}: ${activeWeight} samples</title><rect x="${x.toFixed(2)}" y="${y}" width="${width.toFixed(2)}" height="18" rx="2" fill="hsl(${color} 60% 48%)" stroke="#101a2b" stroke-width="0.5"/>${width > 68 ? `<text x="${(x + 4).toFixed(2)}" y="${y + 13}" fill="#fff" font-size="10">${safeName.slice(0, 24)}</text>` : ""}</g>`,
      );
    };

    for (const sample of sampleStacks) {
      const nodeId = sample.stack[depth];
      if (nodeId !== activeNode) {
        flush();
        activeNode = nodeId;
        activeStart = cumulativeByDepth[depth] ?? 0;
        activeWeight = 0;
      }
      if (nodeId !== undefined) activeWeight += sample.weight;
      cumulativeByDepth[depth] =
        (cumulativeByDepth[depth] ?? 0) + sample.weight;
    }
    flush();
    cumulativeByDepth = cumulativeByDepth.map(() => 0);
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${chartWidth}" height="${chartHeight}" viewBox="0 0 ${chartWidth} ${chartHeight}"><rect width="100%" height="100%" fill="#101a2b"/><text x="40" y="24" fill="#ffffff" font-size="16">${title}</text><text x="40" y="42" fill="#b9c9e2" font-size="11">${profile.samples.length} V8 CPU samples; deeper frames are higher in the call stack</text>${bars.join("")}</svg>`;
  await writeFile(path, `${svg}\n`);
}

function parseMessage(data: RawData): Record<string, unknown> {
  const text = Buffer.isBuffer(data) ? data.toString("utf8") : String(data);
  const parsed: unknown = JSON.parse(text);
  if (!isRecord(parsed)) {
    throw new TypeError("Unexpected WebSocket message.");
  }
  return parsed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function connectBot(
  baseUrl: string,
  roomId: string,
  index: number,
): Promise<{ socket: WebSocket; stop(): void }> {
  const socket = new WebSocket(baseUrl.replace("http:", "ws:") + "/ws");
  await once(socket, "open");
  const joined = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Bot join timed out.")), 5000);
    const onMessage = (data: RawData) => {
      const message = parseMessage(data);
      if (message.type === "server-error") {
        clearTimeout(timer);
        socket.off("message", onMessage);
        reject(new Error(String(message.message)));
      } else if (message.type === "joined") {
        clearTimeout(timer);
        socket.off("message", onMessage);
        resolve();
      }
    };
    socket.on("message", onMessage);
  });
  socket.send(
    JSON.stringify({
      type: "join",
      roomId,
      playerName: `Load bot ${index + 1}`,
    }),
  );
  await joined;

  let seq = 0;
  const timer = setInterval(() => {
    if (socket.readyState !== WebSocket.OPEN) return;
    seq += 1;
    socket.send(
      JSON.stringify({
        type: "input",
        seq,
        tick: Math.floor(performance.now() * 30 / 1000),
        turn: seq % 90 < 45 ? 1 : -1,
        thrust: true,
        brake: false,
        fire: seq % 8 === 0,
      }),
    );
  }, INPUT_INTERVAL_MS);
  return { socket, stop: () => clearInterval(timer) };
}

async function recordBrowser(baseUrl: string): Promise<{
  browser: Browser;
  page: Page;
  heapBefore: number | null;
}> {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.addInitScript(() => {
    window.__labFrameTimes = new Float64Array(10_000);
    window.__labFrameCount = 0;
    window.__labLongFrames = 0;
    let previousFrame = 0;
    const sampleFrame = (now: number) => {
      if (previousFrame > 0) {
        const frameTime = now - previousFrame;
        if (window.__labFrameCount < window.__labFrameTimes.length) {
          window.__labFrameTimes[window.__labFrameCount] = frameTime;
          window.__labFrameCount += 1;
        }
        if (frameTime > 50) window.__labLongFrames += 1;
      }
      previousFrame = now;
      requestAnimationFrame(sampleFrame);
    };
    requestAnimationFrame(sampleFrame);
  });
  await page.goto(baseUrl);
  await page.locator("#joinForm").waitFor({ state: "visible", timeout: 15_000 });
  await page.locator('#joinForm [name="playerName"]').fill("Browser observer");
  await page.locator('#joinForm [name="roomId"]').selectOption("load-room-0");
  await page.getByRole("button", { name: "Join game" }).click();
  await page.locator("#chatForm").waitFor({ state: "visible" });
  await page.waitForTimeout(100);
  await page.evaluate(() => {
    window.__labFrameCount = 0;
    window.__labLongFrames = 0;
  });
  const heapBefore = await page.evaluate(() => {
    return window.performance.memory?.usedJSHeapSize ?? null;
  });
  return { browser, page, heapBefore };
}

async function main(): Promise<void> {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "star-runner-load-"));
  const staticDirectory = join(process.cwd(), "client", "dist");
  const roomDefinitions = join(temporaryDirectory, "rooms.json");
  await writeFile(
    roomDefinitions,
    JSON.stringify({
      rooms: Array.from({ length: ROOM_COUNT }, (_, index) => ({
        id: `load-room-${index}`,
        name: `Load room ${index + 1}`,
        capacity: 16,
        arena: "standard",
      })),
    }),
  );

  const application = await createApplication({
    port: 0,
    logDirectory: join(temporaryDirectory, "logs"),
    staticDirectory,
    roomDefinitions,
    websocketPath: "/ws",
  });
  const bots: Array<{ socket: WebSocket; stop(): void }> = [];
  let browser: Browser | null = null;
  try {
    application.server.listen(0, "127.0.0.1");
    await once(application.server, "listening");
    const address = application.server.address();
    if (!address || typeof address === "string") {
      throw new Error("Load benchmark server failed to start.");
    }
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const results: LoadResult[] = [];

    for (const target of CLIENT_LEVELS) {
      if (target > 8) {
        while (bots.length < target) {
          const index = bots.length;
          const roomId = `load-room-${Math.floor(index / 16)}`;
          if (!application.roomManager.get(roomId)) {
            application.roomManager.create({
              id: roomId,
              name: `Load room ${Math.floor(index / 16) + 1}`,
              capacity: 16,
              arena: "standard",
            });
          }
          bots.push(
            await connectBot(
              baseUrl,
              roomId,
              index,
            ),
          );
        }
        await new Promise((resolve) => setTimeout(resolve, 300));
      }

      const durations: number[] = [];
      const aggregateAverages: number[] = [];
      const gcStart = garbageCollectionDurations.length;
      let poolHits = 0;
      let poolMisses = 0;
      let browserPage: Page | null = null;
      let browserHeapBefore: number | null = null;
      let browserCpuProfile: unknown;
      let browserHeapProfile: unknown;
      let browserInlineFrames: LoadResult["browserInlineFrames"];
      let profile: CDPSession | null = null;

      if (target === 8) {
        const recording = await recordBrowser(baseUrl);
        browser = recording.browser;
        browserPage = recording.page;
        browserHeapBefore = recording.heapBefore;
        profile = await browserPage.context().newCDPSession(browserPage);
        await profile.send("Profiler.enable");
        await profile.send("Profiler.start");
        await profile.send("HeapProfiler.startSampling", { samplingInterval: 1024 });
        await browserPage.evaluate(() => {
          window.__labInlineBotCount = 0;
          window.__labInlineBotSockets = [];
          window.__labInlineBotTimers = [];
          for (let bot = 0; bot < 8; bot += 1) {
            const socket = new window.WebSocket(
              `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/ws`,
            );
            window.__labInlineBotSockets.push(socket);
            socket.addEventListener("open", () => {
              socket.send(
                JSON.stringify({
                  type: "join",
                  roomId: "load-room-0",
                  playerName: `Inline bot ${bot + 1}`,
                }),
              );
            });
            socket.addEventListener("message", (event) => {
              if (typeof event.data !== "string") return;
              let message: unknown;
              try {
                message = JSON.parse(event.data);
              } catch {
                return;
              }
              if (
                typeof message !== "object" ||
                message === null ||
                !("type" in message) ||
                message.type !== "joined"
              ) {
                return;
              }
              let sequence = 0;
              const timer = window.setInterval(() => {
                if (socket.readyState !== 1) return;
                sequence += 1;
                socket.send(
                  JSON.stringify({
                    type: "input",
                    seq: sequence,
                    tick: sequence,
                    turn: sequence % 90 < 45 ? 1 : -1,
                    thrust: true,
                    brake: false,
                    fire: sequence % 8 === 0,
                  }),
                );
              }, 1000 / 30);
              window.__labInlineBotTimers.push(timer);
              window.__labInlineBotCount += 1;
            });
          }
        });
        await browserPage.waitForFunction(
          () => window.__labInlineBotCount === 8,
          { timeout: 10_000 },
        );
        await browserPage.waitForTimeout(5000);
        const inlineMeasurements = await browserPage.evaluate(() => ({
          frameTimes: Array.from(
            window.__labFrameTimes.slice(0, window.__labFrameCount),
          ),
          longFrames: window.__labLongFrames,
        }));
        const inlineCpuProfile = await profile.send("Profiler.stop");
        const inlineHeapProfile = await profile.send("HeapProfiler.stopSampling");
        const outputDirectory = join(process.cwd(), "evidence", "lab-07");
        await mkdir(outputDirectory, { recursive: true });
        await writeFile(
          join(outputDirectory, "client-inline-8-bot-5s.cpuprofile"),
          `${JSON.stringify(inlineCpuProfile, null, 2)}\n`,
        );
        await writeCpuFlameChart(
          join(outputDirectory, "client-inline-8-bot-5s-flame.svg"),
          inlineCpuProfile,
          "Inline bot CPU profile (5 seconds)",
        );
        await writeFile(
          join(outputDirectory, "client-inline-8-bot-5s.heapprofile.json"),
          `${JSON.stringify(inlineHeapProfile, null, 2)}\n`,
        );
        browserInlineFrames = {
          samples: inlineMeasurements.frameTimes.length,
          p50: percentile(inlineMeasurements.frameTimes, 0.5),
          p95: percentile(inlineMeasurements.frameTimes, 0.95),
          p99: percentile(inlineMeasurements.frameTimes, 0.99),
          longFrames: inlineMeasurements.longFrames,
        };
        await browserPage.evaluate(() => {
          for (const timer of window.__labInlineBotTimers) {
            window.clearInterval(timer);
          }
          for (const socket of window.__labInlineBotSockets) socket.close();
          window.__labFrameCount = 0;
          window.__labLongFrames = 0;
        });
        await browserPage.waitForTimeout(300);
        browserHeapBefore = await browserPage.evaluate(
          () => window.performance.memory?.usedJSHeapSize ?? null,
        );
        await profile.send("Profiler.start");
        await profile.send("HeapProfiler.startSampling", { samplingInterval: 1024 });
        await browserPage
          .getByRole("button", { name: "Start 8 Worker bots" })
          .click();
        await browserPage.waitForFunction(() =>
          document.querySelector("#botStatus")?.textContent?.startsWith("8/8"),
        );
        await browserPage.waitForTimeout(100);
      }

      const deadline =
        performance.now() +
        (target === 8 ? EIGHT_BOT_RECORDING_MS : MEASUREMENT_MS);
      while (performance.now() < deadline) {
        const response = await fetch(`${baseUrl}/api/matches/stats`);
        if (!response.ok) throw new Error(`Stats endpoint returned ${response.status}.`);
        const stats = StatsResponseSchema.parse(await response.json());
        const activeMatches = stats.matches.filter((match) => match.players > 0);
        for (const match of activeMatches) durations.push(match.lastTickDurationMs);
        poolHits = Math.max(
          poolHits,
          activeMatches.reduce((total, match) => total + match.poolStats.hits, 0),
        );
        poolMisses = Math.max(
          poolMisses,
          activeMatches.reduce((total, match) => total + match.poolStats.misses, 0),
        );
        aggregateAverages.push(
          activeMatches.reduce(
            (total, match) => total + match.averageTickDurationMs,
            0,
          ),
        );
        await new Promise((resolve) => setTimeout(resolve, 50));
      }

      const result: LoadResult = {
        clients: target,
        samples: durations.length,
        tickDurationMs: {
          p50: percentile(durations, 0.5),
          p95: percentile(durations, 0.95),
          p99: percentile(durations, 0.99),
          max: Math.max(0, ...durations),
          over33ms: durations.filter((duration) => duration > 33).length,
        },
        aggregateAverageStepMs: Number(
          percentile(aggregateAverages, 0.5).toFixed(3),
        ),
        transientObjectPool: {
          reuseHits: poolHits,
          allocationMisses: poolMisses,
        },
        garbageCollectionMs: {
          count: garbageCollectionDurations.length - gcStart,
          total: Number(
            garbageCollectionDurations
              .slice(gcStart)
              .reduce((total, duration) => total + duration, 0)
              .toFixed(3),
          ),
          max: Number(
            Math.max(0, ...garbageCollectionDurations.slice(gcStart)).toFixed(3),
          ),
        },
      };
      if (browserPage) {
        const browserMeasurements = await browserPage.evaluate(() => {
          return {
            frameTimes: Array.from(
              window.__labFrameTimes.slice(0, window.__labFrameCount),
            ),
            longFrames: window.__labLongFrames,
            heapAfter: window.performance.memory?.usedJSHeapSize ?? null,
          };
        });
        if (!profile) throw new Error("Browser profile session did not start.");
        browserCpuProfile = await profile.send("Profiler.stop");
        browserHeapProfile = await profile.send("HeapProfiler.stopSampling");
        const outputDirectory = join(process.cwd(), "evidence", "lab-07");
        await mkdir(outputDirectory, { recursive: true });
        await writeFile(
          join(outputDirectory, "client-8-bot-30s.cpuprofile"),
          `${JSON.stringify(browserCpuProfile, null, 2)}\n`,
        );
        await writeCpuFlameChart(
          join(outputDirectory, "client-8-bot-30s-flame.svg"),
          browserCpuProfile,
          "Worker bot CPU profile (30 seconds)",
        );
        await writeFile(
          join(outputDirectory, "client-8-bot-30s.heapprofile.json"),
          `${JSON.stringify(browserHeapProfile, null, 2)}\n`,
        );
        result.browserFrames = {
          samples: browserMeasurements.frameTimes.length,
          p50: percentile(browserMeasurements.frameTimes, 0.5),
          p95: percentile(browserMeasurements.frameTimes, 0.95),
          p99: percentile(browserMeasurements.frameTimes, 0.99),
          longFrames: browserMeasurements.longFrames,
          maxHeapDeltaBytes:
            browserHeapBefore === null || browserMeasurements.heapAfter === null
              ? null
              : browserMeasurements.heapAfter - browserHeapBefore,
        };
        result.browserInlineFrames = browserInlineFrames;
        const completedBrowser = browser;
        if (!completedBrowser) throw new Error("Browser profile is no longer active.");
        await completedBrowser.close();
        browser = null;
      }
      results.push(result);
      console.log(JSON.stringify(result));
    }

    const outputDirectory = join(process.cwd(), "evidence", "lab-07");
    await mkdir(outputDirectory, { recursive: true });
    await writeFile(
      join(outputDirectory, "load-results.json"),
      `${JSON.stringify({ measuredAt: new Date().toISOString(), results }, null, 2)}\n`,
    );
    await writeLoadChart(join(outputDirectory, "load-results.svg"), results);
  } finally {
    garbageCollectionObserver.disconnect();
    await browser?.close();
    for (const bot of bots) {
      bot.stop();
      bot.socket.close();
    }
    await application.close();
    await new Promise<void>((resolve, reject) =>
      application.server.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

async function writeLoadChart(
  path: string,
  results: readonly LoadResult[],
): Promise<void> {
  const chartWidth = 720;
  const chartHeight = 360;
  const maximum = Math.max(
    33,
    ...results.map((result) => result.tickDurationMs.p99),
  );
  const points = results
    .map((result, index) => {
      const x = 120 + index * 145;
      const y = 285 - (result.tickDurationMs.p99 / maximum) * 230;
      return `${x},${y}`;
    })
    .join(" ");
  const labels = results
    .map((result, index) => {
      const x = 120 + index * 145;
      const y = 310 - (result.tickDurationMs.p99 / maximum) * 230;
      return `<text x="${x}" y="${y}" text-anchor="middle" fill="#e9f2ff" font-size="12">p99 ${result.tickDurationMs.p99.toFixed(2)} ms</text><text x="${x}" y="330" text-anchor="middle" fill="#e9f2ff" font-size="13">${result.clients} clients</text>`;
    })
    .join("");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${chartWidth}" height="${chartHeight}" viewBox="0 0 ${chartWidth} ${chartHeight}"><rect width="100%" height="100%" fill="#101a2b"/><text x="360" y="32" text-anchor="middle" fill="#ffffff" font-size="20">Server tick p99 under WebSocket bot load</text><line x1="70" y1="285" x2="680" y2="285" stroke="#7186a8"/><line x1="70" y1="55" x2="70" y2="285" stroke="#7186a8"/><line x1="70" y1="${285 - (33 / maximum) * 230}" x2="680" y2="${285 - (33 / maximum) * 230}" stroke="#ff8d8d" stroke-dasharray="6 5"/><text x="74" y="${279 - (33 / maximum) * 230}" fill="#ffaaaa" font-size="12">33 ms budget</text><polyline points="${points}" fill="none" stroke="#61d6c5" stroke-width="4"/>${results.map((result, index) => { const x = 120 + index * 145; const y = 285 - (result.tickDurationMs.p99 / maximum) * 230; return `<circle cx="${x}" cy="${y}" r="6" fill="#61d6c5"/>`; }).join("")}${labels}<text x="16" y="175" transform="rotate(-90 16 175)" fill="#b9c9e2" font-size="12">p99 tick duration</text></svg>`;
  await writeFile(path, `${svg}\n`);
}

await main();
