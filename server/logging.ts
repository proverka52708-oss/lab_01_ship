import pino from "pino";
import { z } from "zod";

const level = z
  .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
  .parse(process.env.LOG_LEVEL ?? "info");

export const logger = pino({ level });
