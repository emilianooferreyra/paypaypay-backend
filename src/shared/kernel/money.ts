/**
 * Domain currency codes. Intentionally NOT imported from
 * `generated/prisma/enums` — the whole point of this value object is that the
 * domain does not know Prisma exists. Keep this list in sync with
 * `CurrencyEnum` in prisma/schema.prisma by hand; a mismatch would only ever
 * be caught by the type checker at the persistence boundary, never silently.
 */
export type Currency = "ARS" | "USD" | "USDT" | "BRL";

/** How many decimals a client may send for each currency. */
const CURRENCY_DECIMALS: Record<Currency, number> = {
  ARS: 2,
  USD: 2,
  USDT: 6,
  BRL: 2,
};

/**
 * Internal resolution: every amount is a whole number of 10^-8, the scale of
 * the database columns (`NUMERIC(20,8)`). One scale for every currency means
 * anything the database can hold is representable, and a conversion never has
 * to rescale between two currencies. It is deliberately NOT called "minor
 * units": in Stripe, Adyen or Monzo that is the currency's own cents, and this
 * is not.
 */
export const LEDGER_SCALE = 8;

const LEDGER_UNIT = 10n ** BigInt(LEDGER_SCALE);

/** Every value is strictly smaller than this in magnitude: the NUMERIC(20,8) limit. */
const CEILING_TEXT = "1000000000000";
const CEILING_UNITS = BigInt(CEILING_TEXT) * LEDGER_UNIT;

/** A conversion rate longer than this is not a rate, it is an attack. */
const MAX_RATE_DIGITS = 36;

/**
 * Plain decimal notation only: optional leading minus, digits, optional
 * fractional part. Scientific notation ("1e400") is never valid input for a
 * monetary amount — accepting it would let a client express a balance no
 * real currency can hold.
 */
const AMOUNT_PATTERN = /^(-?)(\d+)(?:\.(\d+))?$/;

/** Same shape as an amount, but never negative — a conversion rate. */
const RATE_PATTERN = /^(\d+)(?:\.(\d+))?$/;

export class InvalidAmountError extends Error {
  constructor(raw: string) {
    super(`"${raw}" is not a valid monetary amount`);
    this.name = "InvalidAmountError";
  }
}

export class PrecisionError extends Error {
  constructor(
    readonly currency: Currency,
    readonly maxDecimals: number,
    raw: string,
  ) {
    super(
      `${currency} supports at most ${maxDecimals} decimal place${maxDecimals === 1 ? "" : "s"}, got "${raw}"`,
    );
    this.name = "PrecisionError";
  }
}

export class CurrencyMismatchError extends Error {
  constructor(a: Currency, b: Currency) {
    super(`Cannot operate on different currencies: ${a} and ${b}`);
    this.name = "CurrencyMismatchError";
  }
}

export class AmountTooLargeError extends Error {
  /** The first value that is not allowed, so callers can word their own message. */
  readonly ceiling = CEILING_TEXT;

  constructor(raw: string) {
    super(`"${raw}" is not below the maximum of ${CEILING_TEXT}`);
    this.name = "AmountTooLargeError";
  }
}

interface ParsedAmount {
  readonly negative: boolean;
  readonly whole: string;
  /** Without trailing zeros: "10.100" has one significant decimal, not three. */
  readonly fraction: string;
}

function parseAmount(raw: string): ParsedAmount {
  const match = AMOUNT_PATTERN.exec(raw);
  if (!match) {
    throw new InvalidAmountError(raw);
  }

  return {
    negative: match[1] === "-",
    whole: match[2].replace(/^0+(?=\d)/, ""),
    fraction: (match[3] ?? "").replace(/0+$/, ""),
  };
}

function toLedgerUnits(parsed: ParsedAmount, raw: string): bigint {
  // 13 digits is the most a value below the ceiling can have. Checking before
  // converting keeps a giant string from being turned into a giant bigint.
  if (parsed.whole.length > CEILING_TEXT.length) {
    throw new AmountTooLargeError(raw);
  }

  const magnitude =
    BigInt(parsed.whole) * LEDGER_UNIT +
    BigInt(parsed.fraction.padEnd(LEDGER_SCALE, "0"));

  return parsed.negative ? -magnitude : magnitude;
}

function parseRate(raw: string): { numerator: bigint; denominator: bigint } {
  const match = RATE_PATTERN.exec(raw);
  if (!match) {
    throw new InvalidAmountError(raw);
  }

  const whole = match[1];
  const fraction = match[2] ?? "";
  if (whole.length + fraction.length > MAX_RATE_DIGITS) {
    throw new InvalidAmountError(raw);
  }

  const numerator = BigInt(whole + fraction);
  if (numerator === 0n) {
    throw new InvalidAmountError(raw);
  }

  return { numerator, denominator: 10n ** BigInt(fraction.length) };
}

/**
 * A monetary amount and its currency, inseparable. The constructor is
 * private, so the only way to obtain a Money is through `of`, `zero` or
 * `restore`, and every value, whatever route produced it, passes the same
 * ceiling check — there is no way to hold an amount the database would reject.
 *
 * The amount is a `bigint` count of 10^-8. No `number`, no float and no
 * decimal library is involved at any point.
 */
export class Money {
  private constructor(
    private readonly ledgerUnits: bigint,
    private readonly currency: Currency,
  ) {}

  /** The single place where a Money is created from a count of ledger units. */
  private static fromUnits(
    ledgerUnits: bigint,
    currency: Currency,
    context?: string,
  ): Money {
    if (ledgerUnits >= CEILING_UNITS || ledgerUnits <= -CEILING_UNITS) {
      throw new AmountTooLargeError(
        context ?? new Money(ledgerUnits, currency).toLedgerString(),
      );
    }

    return new Money(ledgerUnits, currency);
  }

  /** An amount sent by a client: plain decimal, within the currency's decimals. */
  static of(rawAmount: string, currency: Currency): Money {
    const parsed = parseAmount(rawAmount);
    const maxDecimals = CURRENCY_DECIMALS[currency];

    if (parsed.fraction.length > maxDecimals) {
      throw new PrecisionError(currency, maxDecimals, rawAmount);
    }

    return Money.fromUnits(
      toLedgerUnits(parsed, rawAmount),
      currency,
      rawAmount,
    );
  }

  /**
   * Rebuilds a value that was already persisted. Unlike `of`, it does not
   * enforce the currency's precision: storage can hold amounts written before
   * that rule existed (for example the FX rounding that left 1.0005 USD), and
   * refusing to load them would make a wallet that works today fail on read.
   * It accepts up to the 8 decimals the database keeps. Use it only at the
   * persistence boundary, never for client input.
   */
  static restore(rawAmount: string, currency: Currency): Money {
    const parsed = parseAmount(rawAmount);

    if (parsed.fraction.length > LEDGER_SCALE) {
      throw new InvalidAmountError(rawAmount);
    }

    return Money.fromUnits(
      toLedgerUnits(parsed, rawAmount),
      currency,
      rawAmount,
    );
  }

  static zero(currency: Currency): Money {
    return new Money(0n, currency);
  }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw new CurrencyMismatchError(this.currency, other.currency);
    }
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return Money.fromUnits(this.ledgerUnits + other.ledgerUnits, this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return Money.fromUnits(this.ledgerUnits - other.ledgerUnits, this.currency);
  }

  /**
   * Converts to another currency at `rawRate`, truncating toward zero — never
   * rounding — to the target currency's precision. Rounding half-up would
   * manufacture a fraction of a cent that was never actually exchanged;
   * truncation only ever discards value, so the two books involved in a
   * conversion can never be credited more than the source amount justifies.
   * That is also the direction TigerBeetle recommends: round in favor of the
   * liquidity account.
   *
   * `bigint` division truncates toward zero, and truncating to a finer grid
   * and then to a coarser one that contains it gives the same result as
   * truncating once.
   */
  convertTo(targetCurrency: Currency, rawRate: string): Money {
    if (targetCurrency === this.currency) {
      throw new CurrencyMismatchError(this.currency, targetCurrency);
    }

    const { numerator, denominator } = parseRate(rawRate);
    const exact = (this.ledgerUnits * numerator) / denominator;
    const step =
      10n ** BigInt(LEDGER_SCALE - CURRENCY_DECIMALS[targetCurrency]);

    return Money.fromUnits((exact / step) * step, targetCurrency);
  }

  /** Same value, ordering across currencies is not meaningful. */
  equals(other: Money): boolean {
    return (
      this.currency === other.currency && this.ledgerUnits === other.ledgerUnits
    );
  }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.ledgerUnits < other.ledgerUnits;
  }

  isGreaterThanOrEqual(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.ledgerUnits >= other.ledgerUnits;
  }

  isZero(): boolean {
    return this.ledgerUnits === 0n;
  }

  isNegative(): boolean {
    return this.ledgerUnits < 0n;
  }

  getCurrency(): Currency {
    return this.currency;
  }

  /**
   * For showing: the currency's own decimals, rounding half away from zero when
   * the value is finer than that (a legacy balance of 1.0005 USD shows 1.00).
   * Never use it to write to the database; that is `toLedgerString`.
   */
  toString(): string {
    const decimals = CURRENCY_DECIMALS[this.currency];
    const step = 10n ** BigInt(LEDGER_SCALE - decimals);
    const negative = this.ledgerUnits < 0n;
    const magnitude = negative ? -this.ledgerUnits : this.ledgerUnits;

    let quotient = magnitude / step;
    if ((magnitude % step) * 2n >= step) {
      quotient += 1n;
    }

    const base = 10n ** BigInt(decimals);
    const whole = quotient / base;
    const text =
      decimals > 0
        ? `${whole}.${(quotient % base).toString().padStart(decimals, "0")}`
        : `${whole}`;

    // A value that rounds to zero has no sign.
    return negative && quotient !== 0n ? `-${text}` : text;
  }

  /**
   * For writing: the exact value with 8 decimals, never rounded and never in
   * exponent notation. This is what the database stores.
   */
  toLedgerString(): string {
    const negative = this.ledgerUnits < 0n;
    const magnitude = negative ? -this.ledgerUnits : this.ledgerUnits;
    const whole = magnitude / LEDGER_UNIT;
    const fraction = (magnitude % LEDGER_UNIT)
      .toString()
      .padStart(LEDGER_SCALE, "0");

    return `${negative ? "-" : ""}${whole}.${fraction}`;
  }

  /** JSON cannot carry a bigint; a Money serializes as its displayed text. */
  toJSON(): string {
    return this.toString();
  }
}
