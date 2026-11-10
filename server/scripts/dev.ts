import { spawn } from "node:child_process";

const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error("Run the dev command through npm");

const processes = ["server", "client"].map((workspace) =>
  spawn(process.execPath, [npmCli, "run", "dev", "--workspace", workspace], {
    stdio: "inherit",
  }),
);
let stopping = false;

function stop(signal: NodeJS.Signals = "SIGINT"): void {
  if (stopping) return;
  stopping = true;
  for (const child of processes) {
    if (child.exitCode === null && !child.killed) child.kill(signal);
  }
  const forceStop = setTimeout(() => {
    for (const child of processes) {
      if (child.exitCode === null && !child.killed) child.kill("SIGKILL");
    }
  }, 5000);
  forceStop.unref();
}

const signals: NodeJS.Signals[] = ["SIGINT", "SIGTERM"];
for (const signal of signals) {
  process.once(signal, () => stop(signal));
}

for (const child of processes) {
  child.on("error", (error) => {
    console.error("Could not start workspace:", error);
    stop("SIGTERM");
  });
  child.on("exit", (code) => {
    if (code !== 0 && code !== null) {
      process.exitCode = code;
      stop("SIGTERM");
    }
  });
}
