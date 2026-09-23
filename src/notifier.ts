import type { Bot } from "grammy";
import type { Db } from "./db.js";
import type { Logger } from "./logger.js";
import { logTelegramEvent } from "./repository.js";

export class Notifier {
  constructor(
    private readonly bot: Bot,
    private readonly db: Db,
    private readonly userId: bigint,
    private readonly adminId: bigint,
    private readonly logger: Logger
  ) {}

  async send(chatId: bigint, text: string, options: Record<string, unknown> = {}): Promise<void> {
    await logTelegramEvent(this.db, { userId: chatId, direction: "out", eventType: "message", payload: { text, options } });
    try {
      await this.bot.api.sendMessage(chatId.toString(), text, options);
    } catch (error) {
      this.logger.error({ err: error, chatId: chatId.toString() }, "Telegram send failed");
      await logTelegramEvent(this.db, { userId: chatId, direction: "out", eventType: "message.failed", payload: { text, error: error instanceof Error ? error.message : String(error) } });
    }
  }

  async mirror(text: string): Promise<void> {
    await Promise.all([
      this.send(this.userId, text),
      this.adminId === this.userId ? Promise.resolve() : this.send(this.adminId, `👁 Уведомление пользователя\n\n${text}`)
    ]);
  }
}
