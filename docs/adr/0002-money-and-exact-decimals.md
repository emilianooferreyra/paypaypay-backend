# ADR 0002: Represent money as exact decimals through a `Money` value object

- **Status:** accepted (2026-10-01). Money stays exact and is never a float. The internal representation moves to `BigInt` fixed point (option B below); the change that implements it is `money-bigint`. Until it lands, the code still uses `decimal.js`
- **Date:** 2026-10-01
- **Code:** `src/shared/kernel/money.ts` (merged in PR #5); the library is `decimal.js ^10.6.0`

## Context

A JavaScript `number` is a binary floating point value and cannot represent most decimal fractions exactly: `0.1 + 0.2` is `0.30000000000000004`. For money that is a defect, not a rounding detail. The error is small per operation and accumulates across sums, taxes, installments and conversions, until a balance does not reconcile and nobody can say why.

Three facts shape the choice here:

1. **The database already stores exact decimals.** Money columns are `Decimal(20,8)` and similar (`NUMERIC` in PostgreSQL), never `FLOAT`.
2. **Prisma returns those columns as its own `Decimal`.** In the generated client, `Decimal` is `runtime.Decimal`, documented there as `Decimal.js`. Anything that reads a balance gets that API.
3. **The currencies have different scales.** ARS, USD and BRL use 2 decimals, USDT uses 6, and the database keeps 8.

## Industry survey

What the public documentation of payment and banking companies shows about how amounts are represented. This describes **interfaces**, not storage: a public API says how a company chose to expose money, not how it keeps it. Verified by reading each source on 2026-10-01.

| Company | Representation in its public API or core | Source |
|---|---|---|
| Stripe | Integer in the currency's minor unit ("1099 to charge 10.99 USD"); zero-decimal currencies such as JPY use the plain integer | docs.stripe.com/currencies |
| Adyen | Integer in minor units; 2, 0 or 3 decimals depending on the currency | docs.adyen.com, currency codes |
| Monzo | 64-bit integer in minor units ("pennies for GBP") | docs.monzo.com |
| TigerBeetle (ledger database) | Unsigned 128-bit integer in the smallest unit, with an **asset scale** per ledger; exchange rates applied as integer ratios, rounding in favor of the liquidity account | docs.tigerbeetle.com, data modeling and currency exchange |
| Wise | Decimal JSON number (`sourceAmount` of 100 or 1000.00) with a separate ISO 4217 currency field | docs.wise.com, quote |
| Mercado Pago | Numeric `transaction_amount` in the request body (its own examples cast to `float` in PHP) | mercadopago.com developers, create payment |
| Nubank, Belo, Takenos | **No public engineering documentation found** | n/a |

Reading: the strongest cluster (Stripe, Adyen, Monzo, and TigerBeetle as a ledger) uses **integers in minor units**. Wise and Mercado Pago expose decimal numbers at the API, and nothing public says what they store. Nothing could be verified for Nubank, Belo or Takenos; Nubank is known publicly for Clojure and Datomic, an immutable-facts database, which says how it stores history, not how it represents an amount.

Two findings from TigerBeetle apply directly: choose the scale conservatively because it cannot easily be changed, and when converting currencies round **in favor of the liquidity account** to deter arbitrage. The truncation in `Money.convertTo` already follows that direction (the customer receives less, never more).

## Decision

- Money is an immutable `Money` value object holding an exact decimal and a currency, inseparable. The constructor is private; the only entry points are `Money.of` (client input, validated), `Money.zero` and `Money.restore` (already-stored values).
- `Money.of` rejects anything that is not plain decimal notation (no `1e400`, no `NaN`) and anything with more decimals than the currency allows (`PrecisionError`, which carries the currency and the limit).
- Arithmetic never mixes currencies (`CurrencyMismatchError`).
- Conversion between currencies **truncates** (`ROUND_DOWN`) to the target precision. Rounding to nearest can credit a fraction of a cent that was never exchanged; truncation only ever discards value.
- `Money.restore` loads a persisted amount **without** enforcing today's precision. Storage may hold amounts written before the rule existed (for example `1.0005 USD`), and refusing to load them would make a wallet that works today fail on read.
- The library is `decimal.js`, used **only** inside `money.ts`.
- The boundary with Prisma is a `string`: `new Prisma.Decimal(money.toString())` to write, `Money.restore(row.balance.toString(), currency)` to read. No code depends on the two `Decimal` classes being interchangeable.

## Decision on the representation

Decided by the maintainer on 2026-10-01: **option B**. The table records the options that were weighed.

`decimal.js` is a decimal library, not an integer helper. In JavaScript there is no native decimal type, so an exact representation is either a decimal library or `BigInt`. Options:

| | A. Keep `decimal.js` inside `Money` | B. `BigInt` fixed point inside `Money`, no library | C. B, plus integer columns in the database |
|---|---|---|---|
| Matches the strongest industry cluster | Partly (exact, but not integer) | Yes (integers) | Yes, fully |
| New dependency or removal | Keeps `decimal.js` | Removes it from this codebase (Prisma still carries its own) | Same as B |
| Code that changes | None | `money.ts` internals and tests; the public API of `Money` stays | B plus every money column, every migration, all data converted per currency scale |
| Legacy amounts such as `1.0005 USD` | `Money.restore` | Representable if the internal scale is 8, the database scale | Needs a one-off data decision |
| Risk | Two copies of the library at runtime | Hand-written arithmetic: small surface (add, subtract, compare, scale, multiply by a rate with truncation), fully testable | Largest blast radius |

Recommendation: **B**, with an internal scale of 10^-8 (the database scale) and the currency's decimals enforced at the edges (`Money.of` input and string output). It follows the integer approach the leading APIs use, removes the library without touching the database, and keeps every caller unchanged. It is its own change, `money-bigint`, to be done before `exchange-on-money` and `investment-on-money` so those two adopt the final representation once. C is worth revisiting only if the database must become the arbiter of scale.

## Naming

The value object keeps the name **`Money`**. Evidence that it is the conventional name:

- Martin Fowler's pattern is called *Money* ("represents a monetary value") and exists to hold amount and currency together and to manage rounding.
- Square's API calls its object `Money`: an amount in the smallest denomination plus a currency.
- In the Java standard for money (JSR 354) the abstraction is the interface `MonetaryAmount`, and the reference implementations are classes named `Money` (backed by `BigDecimal`) and `FastMoney` (backed by `long`). Both representations live under the same API, which is the situation this ADR describes.
- Stripe, Monzo, Adyen and Wise do not name a type; they expose an `amount` field next to a `currency` field.

What does need precise names is the **internal integer**, because "minor unit" already means something specific in the industry: in Stripe, Adyen and Monzo it is the cents of the currency (scale equal to the currency's decimals). Here the internal resolution is 10^-8 for every currency, which is not a minor unit. Glossary:

| Term | Meaning |
|---|---|
| `Money` | Value object: an amount and a currency, inseparable |
| `Currency` | The currency code (`ARS`, `USD`, `USDT`, `BRL`) |
| `currency decimals` | How many decimals a client may send for that currency (2, 2, 6, 2) |
| `LEDGER_SCALE` | Internal resolution, 8, equal to the database scale |
| `ledgerUnits` | The internal `bigint`: the amount counted in 10^-8 |
| `toMinorUnits()` | Only if an integer is ever exposed in the Stripe style: the amount at the currency's own decimals, not `ledgerUnits` |

The names `minorUnits` and `cents` are not used for the internal field, to avoid confusing the two scales.

## Why decimal.js (the current choice, until `money-bigint` lands)

- **It is the same arithmetic model Prisma already exposes.** One decimal semantics across the application, instead of a second library next to the one Prisma ships.
- **It gives what money needs:** arbitrary precision, explicit rounding modes, exact comparison.
- **It is an ordinary dependency** with a small surface; it is hidden behind `Money`, so replacing it later touches one file.

## Alternatives considered

| Option | Why not (here) |
|---|---|
| Integers in minor units (`BigInt`) | A respected approach, and exact for addition. But the scales differ per currency (2, 6, and 8 in the database), so every conversion and every boundary needs manual scaling and its own rounding rule, which is where mistakes happen. `Number` integers also stop being exact at 2^53, about 90 million units at 8 decimals |
| `big.js` or `bignumber.js` | Equivalent capability, but a second decimal library beside Prisma's |
| A high-level money library | `Money` already is one, shaped by this project's rules (per-currency precision, truncating conversion, `restore`) |
| A native JavaScript decimal | Not available in Node as far as is known; the current status of the language proposal was not checked |

## Consequences

- Float arithmetic on money is a bug to be found in review, not a style choice.
- There are two copies of the decimal library at runtime (the project's and Prisma's), which is why the boundary uses strings.
- A `Decimal` operation alone does not enforce currency precision; that is `Money`'s job, and it only protects code that uses it.

## Where it is and is not used

Verified on 2026-10-01 by reading the code:

| Area | Uses `Money` | Notes |
|---|---|---|
| Deposit, withdraw, send | Yes | Through the unit-of-work port |
| Exchange | **No** | Uses `Prisma.Decimal` and credits `amount x rate` **without truncating** to the target precision. This is the source of sub-cent balances such as `1.0005 USD` |
| Investment buy and sell | **No** | `Number` and `parseFloat`, and the amount arrives as a JSON number; the wallet is debited without the version check |
| Exchange-rate service | No | Computes inverse rates with `parseFloat` |
| Portfolio | No | Floats for display of gains; no money moves |

Moving exchange and investment onto `Money` is tracked as `exchange-on-money` and `investment-on-money`. Until they land, this ADR describes the rule, not the whole codebase.

## What was not verified

- Whether an `instanceof` between the project's `Decimal` and Prisma's would work. The design avoids needing it.
- The current stage of a native decimal type in JavaScript.
- Martin Fowler's *Money* pattern as a published reference; it is the conceptual ancestor of this object but was not re-read for this ADR.

## References

- The project's own tests for `Money` (`money.spec.ts`), which fix the behavior above.
- PostgreSQL `NUMERIC` and the Prisma `Decimal` type, as used in `prisma/schema.prisma`.
