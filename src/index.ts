import { createServer } from "node:http";
import { AutochargingService } from "./autocharging.js";
import { createBot } from "./bot.js";
import { loadConfig } from "./config.js";
import { createDb } from "./db.js";
import { createLogger } from "./logger.js";
import { trxToMicros } from "./money.js";
import { Notifier } from "./notifier.js";
import { bootstrapUsers } from "./repository.js";
import { SohuClient } from "./sohu.js";

const config = loadConfig();
const logger = createLogger(config);
const db = createDb(config);
await db.query("SELECT 1");
await bootstrapUsers(db, config.ALLOWED_USER_ID, config.ADMIN_USER_ID, trxToMicros(config.INITIAL_USER_BALANCE_TRX));

const sohu = new SohuClient(config, db);
const service = new AutochargingService(db, sohu, config, logger);
const { bot, notifier } = createBot(
  config,
  db,
  service,
  (createdBot) => new Notifier(createdBot, db, config.ALLOWED_USER_ID, config.ADMIN_USER_ID, logger),
  logger
);

const health = createServer(async (request, response) => {
  if (request.url !== "/healthz") {
    response.writeHead(404).end("not found");
    return;
  }
  try {
    await db.query("SELECT 1");
    response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true }));
  } catch {
    response.writeHead(503, { "content-type": "application/json" }).end(JSON.stringify({ ok: false }));
  }
});
health.listen(config.PORT, "0.0.0.0", () => logger.info({ port: config.PORT }, "Health server listening"));

const interval = setInterval(() => {
  void service.syncAll((notification) => notifier.mirror(notification.text));
}, config.SOHU_POLL_INTERVAL_SECONDS * 1000);
setTimeout(() => void service.syncAll((notification) => notifier.mirror(notification.text)), 5_000);

let stopping = false;
async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  logger.info({ signal }, "Shutting down");
  clearInterval(interval);
  bot.stop();
  health.close();
  await db.end();
}
process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));

logger.info({ pollIntervalSeconds: config.SOHU_POLL_INTERVAL_SECONDS }, "Starting Telegram polling");
await bot.start({ onStart: (info) => logger.info({ username: info.username }, "Telegram bot started") });
