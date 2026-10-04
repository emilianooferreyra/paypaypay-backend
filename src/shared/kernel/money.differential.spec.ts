import { Prisma } from "../../generated/prisma/client.js";
import { AmountTooLargeError, Currency, Money } from "./money";

/**
 * Differential tests: every Money operation is compared with Prisma's Decimal,
 * which implements the exact decimal arithmetic the previous implementation
 * used and ships with Prisma, so it needs no dependency of its own and keeps
 * working after decimal.js is removed from this project.
 *
 * The inputs come from a seeded generator. The run is deterministic, and a
 * failure prints the seed and the offending input so it can be replayed.
 */
const SEED = 0x9e3779b9;
const CASES = 2500;

const CURRENCIES: readonly Currency[] = ["ARS", "USD", "USDT", "BRL"];
const DECIMALS: Record<Currency, number> = {
  ARS: 2,
  USD: 2,
  USDT: 6,
  BRL: 2,
};
const CEILING = new Prisma.Decimal("1000000000000");

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Rng = () => number;

const int = (rng: Rng, min: number, max: number) =>
  min + Math.floor(rng() * (max - min + 1));

const digits = (rng: Rng, length: number) =>
  Array.from({ length }, () => int(rng, 0, 9)).join("");

function randomAmount(rng: Rng, maxDecimals: number, negatives = true): string {
  const integerDigits = int(rng, 1, 12);
  const first = String(int(rng, 1, 9));
  const integerPart =
    integerDigits === 1 && rng() < 0.2
      ? "0"
      : first + digits(rng, integerDigits - 1);
  const fractionDigits = int(rng, 0, maxDecimals);
  const fraction = fractionDigits > 0 ? `.${digits(rng, fractionDigits)}` : "";
  const sign = negatives && rng() < 0.25 ? "-" : "";
  return `${sign}${integerPart}${fraction}`;
}

function randomRate(rng: Rng): string {
  const integerPart = rng() < 0.5 ? "0" : String(int(rng, 1, 5000));
  const fractionDigits = int(rng, 0, 10);
  const fraction = fractionDigits > 0 ? `.${digits(rng, fractionDigits)}` : "";
  const rate = `${integerPart}${fraction}`;
  return new Prisma.Decimal(rate).isZero() ? "1" : rate;
}

const normalize = (text: string) => text.replace(/^-(0\.0+)$/, "$1");

function same(
  label: string,
  context: string,
  actual: string,
  expected: string,
): void {
  if (actual !== expected) {
    throw new Error(
      `${label} differs (seed=${SEED}) for ${context}: expected ${expected}, got ${actual}`,
    );
  }
}

const tooBig = (value: Prisma.Decimal) =>
  value.abs().greaterThanOrEqualTo(CEILING);

describe("Money against Prisma's Decimal (differential)", () => {
  describe.each(CURRENCIES)("%s", (currency) => {
    const decimals = DECIMALS[currency];

    it("holds the same value after construction", () => {
      const rng = mulberry32(SEED);

      for (let i = 0; i < CASES; i += 1) {
        const raw = randomAmount(rng, decimals);
        const oracle = new Prisma.Decimal(raw);

        same(
          "of",
          raw,
          Money.of(raw, currency).toLedgerString(),
          normalize(oracle.toFixed(8)),
        );
      }
    });

    it("restores stored values of up to 8 decimals without loss", () => {
      const rng = mulberry32(SEED + 1);

      for (let i = 0; i < CASES; i += 1) {
        const raw = randomAmount(rng, 8);
        const oracle = new Prisma.Decimal(raw);

        same(
          "restore",
          raw,
          Money.restore(raw, currency).toLedgerString(),
          normalize(oracle.toFixed(8)),
        );
      }
    });

    it("survives a round trip through Prisma's Decimal exactly as the adapters do it", () => {
      const rng = mulberry32(SEED + 9);

      for (let i = 0; i < CASES; i += 1) {
        const original = Money.restore(randomAmount(rng, 8), currency);

        // Write: a Decimal built from toLedgerString. Read: toFixed(8).
        const stored = new Prisma.Decimal(original.toLedgerString());
        const loaded = Money.restore(stored.toFixed(8), currency);

        same(
          "round trip",
          original.toLedgerString(),
          loaded.toLedgerString(),
          original.toLedgerString(),
        );
        expect(loaded.equals(original)).toBe(true);
      }
    });

    it("adds and subtracts exactly, and refuses what crosses the ceiling", () => {
      const rng = mulberry32(SEED + 2);

      for (let i = 0; i < CASES; i += 1) {
        const a = randomAmount(rng, decimals);
        const b = randomAmount(rng, decimals);
        const da = new Prisma.Decimal(a);
        const db = new Prisma.Decimal(b);

        for (const [name, run, expected] of [
          [
            "add",
            () => Money.of(a, currency).add(Money.of(b, currency)),
            da.plus(db),
          ],
          [
            "subtract",
            () => Money.of(a, currency).subtract(Money.of(b, currency)),
            da.minus(db),
          ],
        ] as const) {
          if (tooBig(expected)) {
            expect(run).toThrow(AmountTooLargeError);
          } else {
            same(
              name,
              `${a} , ${b}`,
              run().toLedgerString(),
              normalize(expected.toFixed(8)),
            );
          }
        }
      }
    });

    it("compares exactly, including values with legacy precision", () => {
      const rng = mulberry32(SEED + 3);

      for (let i = 0; i < CASES; i += 1) {
        const a = randomAmount(rng, 8);
        const b = randomAmount(rng, 8);
        const da = new Prisma.Decimal(a);
        const db = new Prisma.Decimal(b);
        const ma = Money.restore(a, currency);
        const mb = Money.restore(b, currency);

        same(
          "isLessThan",
          `${a} < ${b}`,
          String(ma.isLessThan(mb)),
          String(da.lessThan(db)),
        );
        same(
          "isGreaterThanOrEqual",
          `${a} >= ${b}`,
          String(ma.isGreaterThanOrEqual(mb)),
          String(da.greaterThanOrEqualTo(db)),
        );
        same(
          "equals",
          `${a} == ${b}`,
          String(ma.equals(mb)),
          String(da.equals(db)),
        );
        same("isZero", a, String(ma.isZero()), String(da.isZero()));
        same(
          "isNegative",
          a,
          String(ma.isNegative()),
          String(da.isNegative() && !da.isZero()),
        );
      }
    });

    it("shows a value at the currency precision, rounding half away from zero", () => {
      const rng = mulberry32(SEED + 4);

      for (let i = 0; i < CASES; i += 1) {
        const raw = randomAmount(rng, 8);

        same(
          "toString",
          raw,
          Money.restore(raw, currency).toString(),
          normalize(new Prisma.Decimal(raw).toFixed(decimals)),
        );
      }
    });

    it.each(CURRENCIES.filter((target) => target !== currency))(
      "converts to %s by truncating toward zero",
      (target) => {
        const rng = mulberry32(SEED + 5 + target.length);

        for (let i = 0; i < CASES; i += 1) {
          const raw = randomAmount(rng, decimals);
          const rate = randomRate(rng);
          const expected = new Prisma.Decimal(raw)
            .times(rate)
            .toDecimalPlaces(DECIMALS[target], Prisma.Decimal.ROUND_DOWN);
          const run = () => Money.of(raw, currency).convertTo(target, rate);

          if (tooBig(expected)) {
            expect(run).toThrow(AmountTooLargeError);
          } else {
            same(
              "convertTo",
              `${raw} ${currency} x ${rate} -> ${target}`,
              run().toLedgerString(),
              normalize(expected.toFixed(8)),
            );
          }
        }
      },
    );
  });

  it("is reproducible: the same seed produces the same inputs", () => {
    const first = Array.from({ length: 20 }, mulberry32(SEED));
    const second = Array.from({ length: 20 }, mulberry32(SEED));

    expect(first).toEqual(second);
  });
});
