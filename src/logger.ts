import pino from "pino";
import type { Config } from "./config.js";

export function createLogger(config: Pick<Config, "LOG_LEVEL" | "NODE_ENV">) {
  return pino({
    level: config.LOG_LEVEL,
    redact: {
      paths: ["BOT_TOKEN", "SOHU_API_KEY", "SOHU_API_SECRET", "headers.x-api-key", "headers.x-signature"],
      censor: "[REDACTED]"
    },
    transport: config.NODE_ENV === "development" ? { target: "pino-pretty", options: { colorize: true } } : undefined
  });
}

export type Logger = ReturnType<typeof createLogger>;
