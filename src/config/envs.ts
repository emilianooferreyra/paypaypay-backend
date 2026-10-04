import "dotenv/config";
import { z } from "zod";

export const envSchema = z
  .object({
    PORT: z.string().default("3000").transform(Number),
    ALLOWED_ORIGINS: z
      .string()
      .min(1, "ALLOWED_ORIGINS is required.")
      .transform((val) => val.split(",").map((origin) => origin.trim())),
    DATABASE_URL: z.string().min(1, "DATABASE_URL is required."),
    REDIS_URL: z.string().min(1, "REDIS_URL is required."),
    RESEND_API_KEY: z.string().min(1, "RESEND_API_KEY is required."),
    RESEND_FROM_EMAIL: z.string().min(1, "RESEND_FROM_EMAIL is required."),
    JWT_ACCESS_SECRET: z.string().min(1, "JWT_ACCESS_SECRET is required."),
    JWT_REFRESH_SECRET: z.string().min(1, "JWT_REFRESH_SECRET is required."),
    GOOGLE_CLIENT_ID: z.string().min(1, "GOOGLE_CLIENT_ID is required."),
    GOOGLE_CLIENT_SECRET: z
      .string()
      .min(1, "GOOGLE_CLIENT_SECRET is required."),
    GOOGLE_CALLBACK_URL: z.string().min(1, "GOOGLE_CALLBACK_URL is required."),
    EXCHANGE_RATE_MAX_AGE_MS: z.string().default("300000").transform(Number),
    APPLE_CLIENT_ID: z.string().default(""),
    APPLE_TEAM_ID: z.string().default(""),
    APPLE_KEY_ID: z.string().default(""),
    APPLE_CALLBACK_URL: z.string().default(""),
    RECAPTCHA_SITE_KEY: z.string().default(""),
    RECAPTCHA_SECRET_KEY: z.string().default(""),
    RECAPTCHA_THRESHOLD: z.string().default("0.5"),
    REFRESH_GRACE_PERIOD_MS: z.string().default("2000").transform(Number),
    // How long a money transaction may wait for a pooled connection, and how
    // long it may hold one. Prisma's implicit 2s/5s are left explicit here so
    // they can be tuned per environment without a code change.
    DB_TRANSACTION_MAX_WAIT_MS: z.string().default("5000").transform(Number),
    DB_TRANSACTION_TIMEOUT_MS: z.string().default("10000").transform(Number),
    // Idempotency. A request holds its key for the lease while it runs; the
    // lease has to outlive the longest money transaction (buildIdempotencyConfig
    // enforces 3x max wait + timeout at startup). Finished records are kept for
    // the retention so a client can retry safely for that long.
    IDEMPOTENCY_LEASE_MS: z.string().default("60000").transform(Number),
    IDEMPOTENCY_TTL_HOURS: z.string().default("72").transform(Number),
    // Outbox relay. It lives in the API process; set OUTBOX_RELAY_ENABLED to
    // "false" where it must not run (tests, or an instance that only serves
    // requests). The lease has to be at least twice the webhook timeout, which
    // buildRelayConfig enforces at startup.
    OUTBOX_RELAY_ENABLED: z
      .string()
      .default("true")
      .transform((val) => val === "true"),
    OUTBOX_POLL_INTERVAL_MS: z.string().default("1000").transform(Number),
    OUTBOX_BATCH_SIZE: z.string().default("20").transform(Number),
    OUTBOX_LEASE_MS: z.string().default("60000").transform(Number),
    WEBHOOK_TIMEOUT_MS: z.string().default("5000").transform(Number),
    WEBHOOK_MAX_ATTEMPTS: z.string().default("3").transform(Number),
    CSRF_SECRET: z.string().default("csrf-secret-dev"),
    CSRF_ENABLED: z
      .string()
      .default("true")
      .transform((val) => val === "true"),
    FINNHUB_API_KEY: z.string().default(""),
  })
  .passthrough();

const envParsed = envSchema.safeParse(process.env);

if (!envParsed.success) {
  console.error("❌ Config validation error:", envParsed.error.format());
  throw new Error("Invalid environment variables");
}

export const envs = envParsed.data satisfies z.infer<typeof envSchema>;
