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
    .refine(
      (value: string) => !value.includes("\0"),
      "LOG_DIR must be a valid path",
    )
    .default("logs"),
  ALLOWED_ORIGINS: z
    .string()
    .default(
      "http://localhost:3000,http://127.0.0.1:3000,http://localhost:5173,http://127.0.0.1:5173",
    )
    .transform((value) => value.split(",").map((origin) => origin.trim()))
    .pipe(
      z
        .array(
          z.string().refine((value) => {
            try {
              const url = new URL(value);
              return (
                (url.protocol === "http:" || url.protocol === "https:") &&
                url.pathname === "/" &&
                !url.search &&
                !url.hash
              );
            } catch {
              return false;
            }
          }, "Allowed origins must be HTTP(S) origins without a path"),
        )
        .min(1, "ALLOWED_ORIGINS must contain at least one URL"),
    ),
  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
    .default("info"),
  MAX_CONNECTIONS_PER_IP: z
    .string()
    .regex(/^\d+$/, "MAX_CONNECTIONS_PER_IP must be a positive integer")
    .default("16")
    .transform(Number)
    .pipe(z.number().int().min(1).max(1000)),
  MAX_ROOMS: z
    .string()
    .regex(/^\d+$/, "MAX_ROOMS must be a positive integer")
    .default("100")
    .transform(Number)
    .pipe(z.number().int().min(1).max(10000)),
  MAX_PLAYERS: z
    .string()
    .regex(/^\d+$/, "MAX_PLAYERS must be a positive integer")
    .default("400")
    .transform(Number)
    .pipe(z.number().int().min(1).max(100000)),
  TRUST_PROXY: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
  BUILD_SHA: z.string().trim().min(1).default("dev"),
});

export interface ServerConfig {
  port: number;
  logDirectory: string;
  staticDirectory: string;
  roomDefinitions: string;
  websocketPath: string;
  allowedOrigins?: string[];
  maxConnectionsPerIp?: number;
  maxRooms?: number;
  maxPlayers?: number;
  buildSha?: string;
  trustProxy?: boolean;
  logLevel?: string;
}

export function loadConfig(
  environment: NodeJS.ProcessEnv = process.env,
): ServerConfig {
  const parsed = ConfigEnvironmentSchema.parse({
    ...environment,
    ALLOWED_ORIGINS:
      environment.NODE_ENV === "production" &&
      environment.ALLOWED_ORIGINS === undefined
        ? environment.RENDER === "true"
          ? (environment.RENDER_EXTERNAL_URL ?? "")
          : ""
        : environment.ALLOWED_ORIGINS,
  });
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
    allowedOrigins: parsed.ALLOWED_ORIGINS.map(
      (origin) => new URL(origin).origin,
    ),
    maxConnectionsPerIp: parsed.MAX_CONNECTIONS_PER_IP,
    maxRooms: parsed.MAX_ROOMS,
    maxPlayers: parsed.MAX_PLAYERS,
    buildSha:
      parsed.BUILD_SHA === "dev"
        ? (environment.RENDER_GIT_COMMIT ?? parsed.BUILD_SHA)
        : parsed.BUILD_SHA,
    trustProxy: parsed.TRUST_PROXY,
    logLevel: parsed.LOG_LEVEL,
  };
}

export const config = loadConfig();
