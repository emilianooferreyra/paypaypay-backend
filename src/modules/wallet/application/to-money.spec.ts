import { BadRequestException } from "@nestjs/common";
import { toMoney } from "./to-money";

describe("toMoney", () => {
  it("builds a Money for a valid amount", () => {
    expect(toMoney("500", "ARS").toString()).toBe("500.00");
  });

  it("rejects too many decimals with the same 400 the API already returned", () => {
    const attempt = () => toMoney("10.123", "ARS");

    expect(attempt).toThrow(BadRequestException);
    expect(attempt).toThrow("ARS supports at most 2 decimal places");
  });

  it("uses the precision of each currency", () => {
    expect(toMoney("1.123456", "USDT").toString()).toBe("1.123456");
    expect(() => toMoney("1.1234567", "USDT")).toThrow(
      "USDT supports at most 6 decimal places",
    );
  });

  it("rejects a malformed amount as a bad request, not a server error", () => {
    expect(() => toMoney("abc", "ARS")).toThrow(BadRequestException);
  });

  it("answers 400 for an amount at or above the database ceiling, saying what the ceiling is", () => {
    const attempt = () => toMoney("1000000000000", "ARS");

    expect(attempt).toThrow(BadRequestException);
    expect(attempt).toThrow("amount must be less than 1000000000000");
  });

  it("accepts the largest amount that fits", () => {
    expect(toMoney("999999999999.99", "ARS").toString()).toBe(
      "999999999999.99",
    );
  });
});
