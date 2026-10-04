// Safe defaults so the Zod schema in src/config/envs.ts — which validates and
// throws at import time — can be satisfied without a .env file. Shared by the
// unit and e2e suites so tests run identically on a developer machine and on CI.
process.env.NODE_ENV = process.env.NODE_ENV || "test";
process.env.PORT = process.env.PORT || "3000";
process.env.ALLOWED_ORIGINS =
  process.env.ALLOWED_ORIGINS || "http://localhost:3000";
process.env.DATABASE_URL =
  process.env.DATABASE_URL ||
  "postgresql://postgres:123456@localhost:5432/authdb_test";
process.env.REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379";
process.env.RESEND_API_KEY = process.env.RESEND_API_KEY || "re_mocked";
process.env.RESEND_FROM_EMAIL =
  process.env.RESEND_FROM_EMAIL || "test@test.com";
process.env.JWT_ACCESS_SECRET =
  process.env.JWT_ACCESS_SECRET || "test-access-secret-min-32-chars!!";
process.env.JWT_REFRESH_SECRET =
  process.env.JWT_REFRESH_SECRET || "test-refresh-secret-min-32-chars!";
process.env.GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || "test-client-id";
process.env.GOOGLE_CLIENT_SECRET =
  process.env.GOOGLE_CLIENT_SECRET || "test-client-secret";
process.env.GOOGLE_CALLBACK_URL =
  process.env.GOOGLE_CALLBACK_URL ||
  "http://localhost:3000/api/v1/auth/google/callback";
process.env.CSRF_SECRET = process.env.CSRF_SECRET || "test-csrf-secret";
process.env.CSRF_ENABLED = process.env.CSRF_ENABLED || "false";
// The relay polls the database; tests drive it explicitly with runOnce().
process.env.OUTBOX_RELAY_ENABLED = process.env.OUTBOX_RELAY_ENABLED || "false";
