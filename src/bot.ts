import { Bot, InlineKeyboard, type Context } from "grammy";
import type { AutochargingService } from "./autocharging.js";
import type { Config } from "./config.js";
import type { Db } from "./db.js";
import type { Logger } from "./logger.js";
import { microsToTrx, trxToMicros } from "./money.js";
import type { Notifier } from "./notifier.js";
import { getLatestPrices, getSubscription, getUserBalance, logAudit, logTelegramEvent, recentLedger } from "./repository.js";
import { isValidTronAddress } from "./tron.js";

const awaitingAddress = new Set<string>();

export function createBot(config: Config, db: Db, service: AutochargingService, notifierFactory: (bot: Bot) => Notifier, logger: Logger) {
  const bot = new Bot(config.BOT_TOKEN);
  const notifier = notifierFactory(bot);

  const isUser = (ctx: Context) => ctx.from?.id.toString() === config.ALLOWED_USER_ID.toString();
  const isAdmin = (ctx: Context) => ctx.from?.id.toString() === config.ADMIN_USER_ID.toString();
  const authorized = (ctx: Context) => isUser(ctx) || isAdmin(ctx);

  bot.use(async (ctx, next) => {
    const telegramId = ctx.from ? BigInt(ctx.from.id) : undefined;
    try {
      await logTelegramEvent(db, { updateId: ctx.update.update_id, userId: telegramId, direction: "in", eventType: "update", payload: ctx.update });
    } catch (error) {
      logger.error({ err: error }, "Failed to persist inbound Telegram update");
    }
    if (!authorized(ctx)) {
      await ctx.reply("Доступ запрещён.");
      return;
    }
    await next();
  });

  async function replyLogged(ctx: Context, text: string, keyboard?: InlineKeyboard) {
    if (ctx.from) await logTelegramEvent(db, { userId: BigInt(ctx.from.id), direction: "out", eventType: "reply", payload: { text, keyboard: Boolean(keyboard) } });
    return ctx.reply(text, keyboard ? { reply_markup: keyboard } : undefined);
  }

  async function mainMenu(ctx: Context) {
    const suffix = isAdmin(ctx) ? "\n\n👁 Режим администратора: только просмотр." : "";
    const keyboard = new InlineKeyboard()
      .text("💰 Мой баланс", "balance")
      .row()
      .text("⚡ Автозаряд Pro", "autopay");
    await replyLogged(ctx, `SohuPro Observer Bot${suffix}`, keyboard);
  }

  bot.command("start", mainMenu);
  bot.command("menu", mainMenu);

  bot.callbackQuery("menu", async (ctx) => {
    await ctx.answerCallbackQuery();
    await mainMenu(ctx);
  });

  bot.callbackQuery("balance", async (ctx) => {
    await ctx.answerCallbackQuery();
    const balance = await getUserBalance(db, config.ALLOWED_USER_ID);
    const ledger = await recentLedger(db, config.ALLOWED_USER_ID, 8);
    const history = ledger.length
      ? ledger.map((entry) => {
          const amount = BigInt(entry.amount_micros);
          return `${amount >= 0n ? "+" : ""}${microsToTrx(amount)} TRX — ${entry.description}\nОстаток: ${microsToTrx(BigInt(entry.balance_after_micros))} TRX`;
        }).join("\n\n")
      : "Операций пока нет.";
    await replyLogged(ctx, `💰 Баланс: ${microsToTrx(balance)} TRX\n\nПоследние операции:\n${history}`, new InlineKeyboard().text("← Меню", "menu"));
  });

  bot.callbackQuery("autopay", async (ctx) => {
    await ctx.answerCallbackQuery();
    const subscription = await getSubscription(db, config.ALLOWED_USER_ID);
    if (!subscription) {
      let priceText = "Цена временно недоступна";
      try {
        const prices = await service.currentPrices();
        priceText = `65K — ${microsToTrx(prices.price65Micros + trxToMicros(config.SERVICE_FEE_TRX))} TRX; 131K — ${microsToTrx(prices.price131Micros + trxToMicros(config.SERVICE_FEE_TRX))} TRX`;
      } catch (error) {
        logger.warn({ err: error }, "Could not get live price for menu");
        const cached = await getLatestPrices(db);
        if (cached) priceText = `65K — ${microsToTrx(cached.price65Micros + trxToMicros(config.SERVICE_FEE_TRX))} TRX; 131K — ${microsToTrx(cached.price131Micros + trxToMicros(config.SERVICE_FEE_TRX))} TRX (последние сохранённые)`;
      }
      const keyboard = new InlineKeyboard().text("Подключить", "connect").row().text("← Меню", "menu");
      await replyLogged(ctx,
        `⚡ Автозаряд Pro\n\nМинимум ${config.PRO_MIN_ENERGY_72H.toLocaleString("ru-RU")} энергии за 72 часа.\nЗалог: ${config.PRO_DEPOSIT_TRX} TRX.\n${priceText}. В цену каждого списания включена комиссия ${config.SERVICE_FEE_TRX} TRX.\n\nПри редких переводах тариф может быть невыгоден. Правила возврата залога сейчас проверяются на реальном API.`,
        keyboard
      );
      return;
    }
    const balance = await getUserBalance(db, config.ALLOWED_USER_ID);
    const statusLabels: Record<string, string> = {
      pending: "подключение", active: "активен", paused: "на паузе", disabled: "отключён", low_balance: "пауза: мало средств", error: "ошибка"
    };
    const keyboard = new InlineKeyboard();
    if (subscription.status === "active") keyboard.text("⏸ Пауза", "pause");
    if (["paused", "low_balance"].includes(subscription.status)) keyboard.text("▶️ Возобновить", "resume");
    if (!['disabled', 'error', 'pending'].includes(subscription.status)) keyboard.row().text("⛔ Отключить", "disable_confirm");
    keyboard.row().text("🔄 Обновить", "autopay").text("← Меню", "menu");
    const providerCredit = subscription.souhu_credit_micros == null ? "неизвестен" : `${microsToTrx(BigInt(subscription.souhu_credit_micros))} TRX`;
    const adminDetails = isAdmin(ctx) ? `\nКредит Sohu: ${providerCredit}\nПоследняя синхронизация: ${subscription.last_souhu_sync_at?.toISOString() ?? "ещё не было"}` : "";
    await replyLogged(ctx,
      `⚡ Автозаряд Pro\nАдрес: ${subscription.tron_address}\nСтатус: ${statusLabels[subscription.status] ?? subscription.status}\nБаланс: ${microsToTrx(balance)} TRX\nЗалог: ${microsToTrx(BigInt(subscription.deposit_micros))} TRX (${subscription.deposit_status})\nЦикл: ${Number(subscription.cycle_energy_used).toLocaleString("ru-RU")} / ${Number(subscription.minimum_energy_72h).toLocaleString("ru-RU")} энергии\nДо: ${new Date(subscription.cycle_ends_at).toLocaleString("ru-RU", { timeZone: "Europe/Moscow" })}${subscription.last_error ? `\nОшибка: ${subscription.last_error}` : ""}${adminDetails}`,
      keyboard
    );
  });

  bot.callbackQuery("connect", async (ctx) => {
    await ctx.answerCallbackQuery();
    if (isAdmin(ctx)) {
      await replyLogged(ctx, "Режим администратора: подключение услуги запрещено.", new InlineKeyboard().text("← Назад", "autopay"));
      return;
    }
    awaitingAddress.add(String(ctx.from.id));
    await replyLogged(ctx, "Отправьте публичный TRON-адрес (начинается с T). Приватный ключ или seed-фраза не нужны и никогда не должны отправляться боту.");
  });

  bot.on("message:text", async (ctx, next) => {
    if (!awaitingAddress.has(String(ctx.from.id)) || ctx.message.text.startsWith("/")) return next();
    const address = ctx.message.text.trim();
    if (!isValidTronAddress(address)) {
      await replyLogged(ctx, "Адрес не прошёл проверку TRON Base58Check. Проверьте его и отправьте ещё раз.");
      return;
    }
    awaitingAddress.delete(String(ctx.from.id));
    await replyLogged(ctx, "Адрес валиден. Подключаю Автозаряд Pro; это может занять несколько секунд…");
    try {
      await service.connect(config.ALLOWED_USER_ID, address);
      const balance = await getUserBalance(db, config.ALLOWED_USER_ID);
      await notifier.mirror(`✅ Автозаряд Pro подключён.\nАдрес: ${address}\nСписан залог: ${config.PRO_DEPOSIT_TRX} TRX.\nОстаток: ${microsToTrx(balance)} TRX.`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await notifier.mirror(`❌ Подключение Автозаряда Pro не завершено.\n${message}\nАвтоматический повтор отключён для защиты от двойного пополнения Sohu.`);
    }
  });

  for (const action of ["pause", "resume"] as const) {
    bot.callbackQuery(action, async (ctx) => {
      await ctx.answerCallbackQuery();
      if (isAdmin(ctx)) {
        await replyLogged(ctx, "Режим администратора: изменение услуги запрещено.", new InlineKeyboard().text("← Назад", "autopay"));
        return;
      }
      try {
        await service.changeState(config.ALLOWED_USER_ID, action);
        const label = action === "pause" ? "поставлен на паузу" : "возобновлён";
        await notifier.mirror(`Автозаряд Pro ${label}.`);
      } catch (error) {
        await replyLogged(ctx, `Не удалось изменить состояние: ${error instanceof Error ? error.message : String(error)}`);
      }
    });
  }

  bot.callbackQuery("disable_confirm", async (ctx) => {
    await ctx.answerCallbackQuery();
    if (isAdmin(ctx)) {
      await replyLogged(ctx, "Режим администратора: отключение услуги запрещено.", new InlineKeyboard().text("← Назад", "autopay"));
      return;
    }
    await replyLogged(ctx, "Отключить автозаряд? Sohu будет остановлен. Залог автоматически не возвращаем, пока не подтверждены правила провайдера.", new InlineKeyboard().text("Да, отключить", "disable").text("Отмена", "autopay"));
  });

  bot.callbackQuery("disable", async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!isUser(ctx)) return;
    try {
      await service.changeState(config.ALLOWED_USER_ID, "disable");
      await notifier.mirror("⛔ Автозаряд Pro отключён. Состояние залога остаётся на сверке с Sohu.");
    } catch (error) {
      await replyLogged(ctx, `Не удалось отключить: ${error instanceof Error ? error.message : String(error)}`);
    }
  });

  bot.catch(async (error) => {
    logger.error({ err: error.error, updateId: error.ctx.update.update_id }, "Telegram handler failed");
    await logAudit(db, { actorId: error.ctx.from ? BigInt(error.ctx.from.id) : undefined, eventType: "telegram.handler.failed", payload: { updateId: error.ctx.update.update_id, error: error.error instanceof Error ? error.error.message : String(error.error) } });
  });

  return { bot, notifier };
}
