import { z } from "zod";

const positiveId = z.coerce.bigint().positive();

const schema = z.object({
  BOT_TOKEN: z.string().min(10),
  ALLOWED_USER_ID: positiveId,
  ADMIN_USER_ID: positiveId,
  DATABASE_URL: z.string().url(),
  SOHU_BASE_URL: z.string().url().default("https://weidubot.cc/api/v2"),
  SOHU_API_KEY: z.string().min(1),
  SOHU_API_SECRET: z.string().min(1),
  SOHU_INITIAL_CREDIT_TRX: z.coerce.number().positive().default(20),
  SOHU_CREDIT_RESERVE_ORDERS: z.coerce.number().int().min(1).max(20).default(2),
  SOHU_CREDIT_TOPUP_TRX: z.coerce.number().positive().default(20),
  SOHU_CREDIT_TOPUP_COOLDOWN_SECONDS: z.coerce.number().int().min(60).max(86400).default(900),
  SOHU_NET_PROTECT: z.enum(["open", "close"]).default("open"),
  SOHU_POLL_INTERVAL_SECONDS: z.coerce.number().int().min(30).max(3600).default(90),
  SOHU_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(1000).max(120000).default(20000),
  INITIAL_USER_BALANCE_TRX: z.coerce.number().nonnegative().default(100),
  SERVICE_FEE_TRX: z.coerce.number().nonnegative().default(0.3),
  PRO_DEPOSIT_TRX: z.coerce.number().nonnegative().default(15),
  PRO_MIN_ENERGY_72H: z.coerce.number().int().positive().default(460000),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  LOG_LEVEL: z.string().default("info"),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development")
});

export type Config = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const result = schema.safeParse(env);
  if (!result.success) {
    const details = result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ");
    throw new Error(`Invalid environment configuration: ${details}`);
  }
  if (result.data.ALLOWED_USER_ID === result.data.ADMIN_USER_ID) {
    throw new Error("ALLOWED_USER_ID and ADMIN_USER_ID must be different");
  }
  return result.data;
}
