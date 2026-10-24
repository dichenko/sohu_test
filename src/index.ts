import { createServer } from "node:http";
import { InlineKeyboard } from "grammy";
import { AutochargingService } from "./autocharging.js";
import { createBot } from "./bot.js";
import { loadConfig } from "./config.js";
import { createDb } from "./db.js";
import { createLogger } from "./logger.js";
import { Notifier } from "./notifier.js";
import { bootstrapUsers, logAudit } from "./repository.js";
import { SohuClient } from "./sohu.js";

const config = loadConfig();
const logger = createLogger(config);
const db = createDb(config);
await db.query("SELECT 1");
await bootstrapUsers(db, config.ALLOWED_USER_ID, config.ADMIN_USER_ID);

const sohu = new SohuClient(config, db);
const service = new AutochargingService(db, sohu, config, logger);
const { bot, notifier } = createBot(
  config,
  db,
  service,
  (createdBot) => new Notifier(createdBot, db, config.ALLOWED_USER_ID, config.ADMIN_USER_ID, logger),
  logger
);

// bot.init() verifies the Telegram token before the deployment notification.
// The Sohu request is authenticated and persisted by SohuClient in provider_http_logs.
await bot.init();
try {
  const providerAccount = await sohu.getUserInfo();
  await logAudit(db, {
    eventType: "deployment.connectivity.succeeded",
    entityType: "deployment",
    payload: {
      telegram_bot: bot.botInfo.username,
      sohu_balance_trx: providerAccount.data.balance_trx,
      sohu_balance_usdt: providerAccount.data.balance_usdt
    }
  });
  await notifier.send(
    config.ADMIN_USER_ID,
    `✅ Деплой успешно завершён, связь с SOHU установлена.\n\nTelegram: @${bot.botInfo.username}\nАвторизация Sohu: успешна\nБаланс Sohu: ${providerAccount.data.balance_trx} TRX / ${providerAccount.data.balance_usdt} USDT`
  );
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  logger.error({ err: error }, "Deployment Sohu connectivity check failed");
  await logAudit(db, {
    eventType: "deployment.connectivity.failed",
    entityType: "deployment",
    payload: { telegram_bot: bot.botInfo.username, error: message }
  });
  await notifier.send(
    config.ADMIN_USER_ID,
    `❌ Бот запущен, но проверка связи с SOHU не пройдена.\n\nTelegram: @${bot.botInfo.username}\nОшибка: ${message}\nПроверьте SOHU_API_KEY, SOHU_API_SECRET, время сервера и provider_http_logs.`
  );
}

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

let stopping = false;
let syncTask: Promise<void> | undefined;
async function synchronize() {
  if (stopping || syncTask) return;
  syncTask = (async () => {
    try {
      await service.syncAll();
      await service.deliverNotifications((notification, recipient) => notifier.send(
        recipient === 'admin' ? config.ADMIN_USER_ID : config.ALLOWED_USER_ID,
        (recipient === 'admin' ? '👁 Уведомление пользователя\n\n' : '') + notification.text,
        { reply_markup: new InlineKeyboard().text('💰 Пополнить', `topup:${notification.subscriptionId}`).text('Открыть адрес', `a:${notification.subscriptionId}`) }
      ));
    } catch (error) { logger.error({ err: error }, 'Background synchronization failed'); }
  })();
  await syncTask;
  syncTask = undefined;
}
const interval = setInterval(() => void synchronize(), config.SOHU_POLL_INTERVAL_SECONDS * 1000);
const initialSync = setTimeout(() => void synchronize(), 5_000);
async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  logger.info({ signal }, "Shutting down");
  clearInterval(interval);
  clearTimeout(initialSync);
  if (bot.isRunning()) await bot.stop();
  health.close();
  await syncTask;
  await db.end();
}
process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));

logger.info({ pollIntervalSeconds: config.SOHU_POLL_INTERVAL_SECONDS }, "Starting Telegram polling");
await bot.start({ onStart: (info) => logger.info({ username: info.username }, "Telegram bot started") });
