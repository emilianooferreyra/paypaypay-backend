import {
  AmountTooLargeError,
  CurrencyMismatchError,
  InvalidAmountError,
  Money,
  PrecisionError,
} from "./money";

describe("Money", () => {
  describe("construction", () => {
    it("keeps the amount exact — no binary floating point", () => {
      const sum = Money.of("0.1", "ARS").add(Money.of("0.2", "ARS"));

      expect(sum.toString()).toBe("0.30");
      expect(0.1 + 0.2).not.toBe(0.3); // the bug this type exists to prevent
    });

    it("formats at the precision of its currency", () => {
      expect(Money.of("100.5", "ARS").toString()).toBe("100.50");
      expect(Money.of("1", "USDT").toString()).toBe("1.000000");
    });

    it("rejects more decimal places than the currency allows", () => {
      expect(() => Money.of("10.123", "ARS")).toThrow(PrecisionError);
      expect(() => Money.of("10.1234567", "USDT")).toThrow(PrecisionError);
    });

    it("accepts the exact number of decimal places the currency allows", () => {
      expect(Money.of("10.12", "ARS").toString()).toBe("10.12");
      expect(Money.of("10.123456", "USDT").toString()).toBe("10.123456");
    });

    it("rejects values that are not finite numbers", () => {
      for (const bad of ["", " ", "abc", "1,5", "NaN", "Infinity", "1e400"]) {
        expect(() => Money.of(bad, "ARS")).toThrow(InvalidAmountError);
      }
    });

    it("builds a zero amount", () => {
      expect(Money.zero("USD").toString()).toBe("0.00");
      expect(Money.zero("USD").isZero()).toBe(true);
    });

    it("allows negative amounts — a ledger needs both directions", () => {
      const debit = Money.of("-50", "ARS");

      expect(debit.isNegative()).toBe(true);
      expect(debit.toString()).toBe("-50.00");
    });
  });

  describe("precision error details", () => {
    it("exposes the currency and the allowed decimals so callers can word their own message", () => {
      let caught: unknown;
      try {
        Money.of("10.123", "ARS");
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(PrecisionError);
      expect((caught as PrecisionError).currency).toBe("ARS");
      expect((caught as PrecisionError).maxDecimals).toBe(2);
    });
  });

  describe("restoring a stored value", () => {
    // A balance written before precision was enforced (for example the FX
    // rounding that left 1.0005 USD) must still be readable, or a wallet that
    // works today would start failing the moment it is loaded.
    it("keeps precision that Money.of would reject", () => {
      expect(() => Money.of("1.0005", "USD")).toThrow(PrecisionError);

      const legacy = Money.restore("1.0005", "USD");

      expect(legacy.isGreaterThanOrEqual(Money.of("1.00", "USD"))).toBe(true);
      expect(legacy.isLessThan(Money.of("1.01", "USD"))).toBe(true);
    });

    it("compares exactly, without rounding to the currency precision", () => {
      const legacy = Money.restore("1.0005", "USD");

      expect(legacy.isLessThan(Money.of("1.00", "USD"))).toBe(false);
      expect(
        Money.restore("1.004", "USD").isLessThan(Money.of("1.00", "USD")),
      ).toBe(false);
    });

    it("still rejects input that is not a plain decimal", () => {
      for (const bad of ["", "abc", "1e400", "NaN"]) {
        expect(() => Money.restore(bad, "USD")).toThrow(InvalidAmountError);
      }
    });
  });

  describe("arithmetic", () => {
    it("adds and subtracts within the same currency", () => {
      const balance = Money.of("1000.00", "ARS");

      expect(balance.add(Money.of("250.50", "ARS")).toString()).toBe("1250.50");
      expect(balance.subtract(Money.of("250.50", "ARS")).toString()).toBe(
        "749.50",
      );
    });

    it("refuses to add different currencies", () => {
      expect(() => Money.of("100", "USD").add(Money.of("100", "ARS"))).toThrow(
        CurrencyMismatchError,
      );
    });

    it("refuses to subtract different currencies", () => {
      expect(() =>
        Money.of("100", "USD").subtract(Money.of("100", "ARS")),
      ).toThrow(CurrencyMismatchError);
    });

    it("names both currencies in the mismatch error", () => {
      expect(() => Money.of("100", "USD").add(Money.of("100", "ARS"))).toThrow(
        /USD.*ARS|ARS.*USD/,
      );
    });

    it("never mutates either operand", () => {
      const a = Money.of("100.00", "ARS");
      const b = Money.of("50.00", "ARS");

      a.add(b);
      a.subtract(b);

      expect(a.toString()).toBe("100.00");
      expect(b.toString()).toBe("50.00");
    });
  });

  describe("comparison", () => {
    it("compares amounts of the same currency", () => {
      const hundred = Money.of("100.00", "ARS");

      expect(hundred.isLessThan(Money.of("100.01", "ARS"))).toBe(true);
      expect(hundred.isLessThan(Money.of("99.99", "ARS"))).toBe(false);
      expect(hundred.isGreaterThanOrEqual(Money.of("100.00", "ARS"))).toBe(
        true,
      );
      expect(hundred.equals(Money.of("100.00", "ARS"))).toBe(true);
    });

    it("refuses to compare different currencies", () => {
      expect(() =>
        Money.of("100", "USD").isLessThan(Money.of("100", "ARS")),
      ).toThrow(CurrencyMismatchError);
    });

    it("is not equal to the same amount in another currency", () => {
      expect(Money.of("100", "USD").equals(Money.of("100", "ARS"))).toBe(false);
    });
  });

  describe("conversion", () => {
    it("converts to another currency at a rate", () => {
      const pesos = Money.of("100000.00", "ARS");

      expect(pesos.convertTo("USD", "0.001").toString()).toBe("100.00");
    });

    it("truncates instead of rounding up — conversion never creates money", () => {
      // 10.005 USD at 2 decimals would round half-up to 10.01, inventing a cent.
      expect(
        Money.of("1000.50", "ARS").convertTo("USD", "0.01").toString(),
      ).toBe("10.00");
    });

    it("rejects a non-positive or malformed rate", () => {
      const pesos = Money.of("100", "ARS");

      for (const bad of ["0", "-1", "abc", ""]) {
        expect(() => pesos.convertTo("USD", bad)).toThrow(InvalidAmountError);
      }
    });

    it("refuses to convert a currency to itself", () => {
      expect(() => Money.of("100", "ARS").convertTo("ARS", "1")).toThrow(
        CurrencyMismatchError,
      );
    });
  });

  describe("the internal representation", () => {
    it("writes zero with 8 decimals", () => {
      expect(Money.zero("ARS").toLedgerString()).toBe("0.00000000");
      expect(Money.of("0", "USD").toLedgerString()).toBe("0.00000000");
    });

    it("has no negative zero", () => {
      const negativeZero = Money.of("-0", "ARS");

      expect(negativeZero.isZero()).toBe(true);
      expect(negativeZero.isNegative()).toBe(false);
      expect(negativeZero.toLedgerString()).toBe("0.00000000");
    });

    it("accepts leading zeros, as the plain-decimal pattern always did", () => {
      expect(Money.of("007.50", "ARS").toString()).toBe("7.50");
    });

    it("writes every value with exactly 8 decimals and no exponent", () => {
      expect(Money.of("500", "ARS").toLedgerString()).toBe("500.00000000");
      expect(Money.of("-5.5", "ARS").toLedgerString()).toBe("-5.50000000");
      expect(Money.of("0.000001", "USDT").toLedgerString()).toBe("0.00000100");
      expect(Money.restore("0.00000005", "USD").toLedgerString()).toBe(
        "0.00000005",
      );
      expect(Money.restore("1.0005", "USD").toLedgerString()).toBe(
        "1.00050000",
      );
    });
  });

  describe("restoring the smallest values the database keeps", () => {
    it("accepts 8 decimals and nothing finer", () => {
      expect(Money.restore("0.00000001", "USD").isZero()).toBe(false);
      expect(() => Money.restore("0.000000001", "USD")).toThrow(
        InvalidAmountError,
      );
    });

    it("rejects exponent notation, which is what Decimal prints for dust", () => {
      for (const bad of ["1e-7", "1e-8", "5e-8", "NaN", "", "abc"]) {
        expect(() => Money.restore(bad, "USD")).toThrow(InvalidAmountError);
      }
    });
  });

  describe("the ceiling of 10^12", () => {
    it("accepts the largest value of each currency", () => {
      expect(() => Money.of("999999999999.99", "ARS")).not.toThrow();
      expect(() => Money.of("999999999999.999999", "USDT")).not.toThrow();
      expect(() => Money.restore("999999999999.99999999", "USD")).not.toThrow();
    });

    it("rejects 10^12 and above, positive or negative", () => {
      expect(() => Money.of("1000000000000", "ARS")).toThrow(
        AmountTooLargeError,
      );
      expect(() => Money.of("-1000000000000", "ARS")).toThrow(
        AmountTooLargeError,
      );
      expect(() => Money.restore("1000000000000.00000000", "USD")).toThrow(
        AmountTooLargeError,
      );
    });

    it("rejects a sum or a difference that crosses it", () => {
      const big = Money.of("600000000000", "ARS");

      expect(() => big.add(big)).toThrow(AmountTooLargeError);
      expect(() => big.subtract(Money.of("-600000000000", "ARS"))).toThrow(
        AmountTooLargeError,
      );
      expect(() => Money.of("-600000000000", "ARS").subtract(big)).toThrow(
        AmountTooLargeError,
      );
    });

    it("rejects a conversion whose result crosses it", () => {
      expect(() =>
        Money.of("999999999999", "ARS").convertTo("USD", "2"),
      ).toThrow(AmountTooLargeError);
    });

    it("carries the ceiling so callers can word their own message", () => {
      let caught: unknown;
      try {
        Money.of("1000000000000", "ARS");
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(AmountTooLargeError);
      expect((caught as AmountTooLargeError).ceiling).toBe("1000000000000");
    });
  });

  describe("showing and writing are different operations", () => {
    it("shows a legacy balance at the currency precision, rounding half away from zero", () => {
      expect(Money.restore("1.0005", "USD").toString()).toBe("1.00");
      expect(Money.restore("1.005", "USD").toString()).toBe("1.01");
      expect(Money.restore("-1.005", "USD").toString()).toBe("-1.01");
      expect(Money.restore("1.004", "USD").toString()).toBe("1.00");
    });

    it("never shows a negative zero", () => {
      expect(Money.restore("-0.004", "USD").toString()).toBe("0.00");
    });

    it("keeps writing exact when showing would round", () => {
      const legacy = Money.restore("1.0005", "USD");

      expect(legacy.toString()).toBe("1.00");
      expect(legacy.toLedgerString()).toBe("1.00050000");
    });

    it("serializes to JSON as its displayed text instead of throwing on a bigint", () => {
      expect(JSON.stringify({ amount: Money.of("500", "ARS") })).toBe(
        '{"amount":"500.00"}',
      );
    });
  });

  describe("conversion edge cases", () => {
    it("converts exactly when the result fits", () => {
      expect(Money.of("100", "ARS").convertTo("USD", "0.001").toString()).toBe(
        "0.10",
      );
    });

    it("1000.50 ARS at 0.001 is 1.00 USD, not 1.0005 and not 1.01", () => {
      const usd = Money.of("1000.50", "ARS").convertTo("USD", "0.001");

      expect(usd.toString()).toBe("1.00");
      expect(usd.toLedgerString()).toBe("1.00000000");
    });

    it("truncates a negative amount toward zero, not toward minus infinity", () => {
      expect(
        Money.of("-1000.50", "ARS").convertTo("USD", "0.001").toLedgerString(),
      ).toBe("-1.00000000");
    });

    it("uses the precision of the target currency", () => {
      expect(
        Money.of("1", "USD").convertTo("USDT", "1.23456789").toString(),
      ).toBe("1.234567");
    });

    it("gives zero when the result is smaller than the target precision", () => {
      expect(Money.of("1", "ARS").convertTo("USD", "0.00000001").isZero()).toBe(
        true,
      );
    });

    it("accepts a rate with many decimals and rejects an absurdly long one", () => {
      expect(() =>
        Money.of("1", "ARS").convertTo("USD", "0.000000000000000001"),
      ).not.toThrow();
      expect(() =>
        Money.of("1", "ARS").convertTo("USD", "1".repeat(37)),
      ).toThrow(InvalidAmountError);
    });

    it("treats equal values written differently as equal", () => {
      expect(Money.of("10", "ARS").equals(Money.of("10.00", "ARS"))).toBe(true);
    });
  });
});
