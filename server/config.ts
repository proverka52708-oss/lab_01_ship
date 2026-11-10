import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const serverDirectory = fileURLToPath(new URL(".", import.meta.url));
const projectDirectory = resolve(serverDirectory, "..");

export const ConfigEnvironmentSchema = z.object({
  PORT: z
    .string()
    .regex(/^\d+$/, "PORT must be an integer between 1 and 65535")
    .default("3000")
    .transform(Number)
    .pipe(
      z
        .number()
        .int("PORT must be an integer between 1 and 65535")
        .min(1, "PORT must be an integer between 1 and 65535")
        .max(65535, "PORT must be an integer between 1 and 65535"),
    ),
  LOG_DIR: z
    .string()
    .trim()
    .min(1, "LOG_DIR must be a non-empty valid path")
    .refine((value: string) => !value.includes("\0"), "LOG_DIR must be a valid path")
    .default("logs"),
});

export interface ServerConfig {
  port: number;
  logDirectory: string;
  staticDirectory: string;
  roomDefinitions: string;
  websocketPath: string;
}

export function loadConfig(environment: NodeJS.ProcessEnv = process.env): ServerConfig {
  const parsed = ConfigEnvironmentSchema.parse(environment);
  return {
    port: parsed.PORT,
    logDirectory: resolve(projectDirectory, parsed.LOG_DIR),
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
