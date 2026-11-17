export type KeyValidation =
  | { ok: true; key: string }
  | {
      ok: false;
      reason:
        | "missing"
        | "empty"
        | "multiple"
        | "too_long"
        | "invalid_characters";
    };

const MAX_LENGTH = 255;
const ALLOWED = /^[A-Za-z0-9._:-]+$/;

/** Validates the raw `Idempotency-Key` header value. */
export function validateKey(raw: string | string[] | undefined): KeyValidation {
  if (raw === undefined) return { ok: false, reason: "missing" };
  if (Array.isArray(raw)) return { ok: false, reason: "multiple" };
  if (raw.length === 0) return { ok: false, reason: "empty" };
  if (raw.length > MAX_LENGTH) return { ok: false, reason: "too_long" };
  if (!ALLOWED.test(raw)) return { ok: false, reason: "invalid_characters" };

  return { ok: true, key: raw };
}
