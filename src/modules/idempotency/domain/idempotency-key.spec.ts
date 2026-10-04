import { randomUUID } from "node:crypto";
import { validateKey } from "./idempotency-key";

describe("validateKey", () => {
  it("accepts a UUID", () => {
    const key = randomUUID();

    expect(validateKey(key)).toEqual({ ok: true, key });
  });

  it("accepts a composite key made of the allowed characters", () => {
    for (const key of ["payment-1234-refund", "a.b_c:d-e", "A1", "x"]) {
      expect(validateKey(key)).toEqual({ ok: true, key });
    }
  });

  it("accepts exactly 255 characters and refuses 256", () => {
    expect(validateKey("a".repeat(255))).toEqual({
      ok: true,
      key: "a".repeat(255),
    });
    expect(validateKey("a".repeat(256))).toEqual({
      ok: false,
      reason: "too_long",
    });
  });

  it("reports a missing header", () => {
    expect(validateKey(undefined)).toEqual({ ok: false, reason: "missing" });
  });

  it("reports an empty key", () => {
    expect(validateKey("")).toEqual({ ok: false, reason: "empty" });
  });

  it("refuses characters outside the allowed set", () => {
    for (const key of [
      "a b",
      "a\nb",
      " leading",
      "trailing ",
      "ñandú",
      "a/b",
      "a;b",
      "a\tb",
    ]) {
      expect(validateKey(key)).toEqual({
        ok: false,
        reason: "invalid_characters",
      });
    }
  });

  it("refuses a header sent more than once", () => {
    expect(validateKey(["one", "two"])).toEqual({
      ok: false,
      reason: "multiple",
    });
  });
});
