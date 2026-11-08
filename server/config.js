import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const serverDirectory = fileURLToPath(new URL(".", import.meta.url));
const projectDirectory = resolve(serverDirectory, "..");

function parsePort(value) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("PORT must be an integer between 1 and 65535");
  }
  return port;
}

function parseLogDirectory(value) {
  if (
    typeof value !== "string" ||
    value.trim() === "" ||
    value.includes("\0")
  ) {
    throw new Error("LOG_DIR must be a non-empty valid path");
  }
  return resolve(projectDirectory, value);
}

export function loadConfig(environment = process.env) {
  return {
    port: parsePort(environment.PORT ?? "3000"),
    logDirectory: parseLogDirectory(environment.LOG_DIR ?? "logs"),
    staticDirectory: resolve(projectDirectory, "client", "dist"),
    roomDefinitions: resolve(
      projectDirectory,
      "client",
      "public",
      "api",
      "rooms.json",
    ),
    websocketPath: "/ws",
  };
}

export const config = loadConfig();
