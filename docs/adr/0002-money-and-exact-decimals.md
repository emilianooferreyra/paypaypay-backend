# ADR 0002: Represent money as exact decimals through a `Money` value object

- **Status:** accepted, partially applied (see "Where it is and is not used")
- **Date:** 2026-10-01
- **Code:** `src/shared/kernel/money.ts` (merged in PR #5); the library is `decimal.js ^10.6.0`

## Context

A JavaScript `number` is a binary floating point value and cannot represent most decimal fractions exactly: `0.1 + 0.2` is `0.30000000000000004`. For money that is a defect, not a rounding detail. The error is small per operation and accumulates across sums, taxes, installments and conversions, until a balance does not reconcile and nobody can say why.

Three facts shape the choice here:

1. **The database already stores exact decimals.** Money columns are `Decimal(20,8)` and similar (`NUMERIC` in PostgreSQL), never `FLOAT`.
2. **Prisma returns those columns as its own `Decimal`.** In the generated client, `Decimal` is `runtime.Decimal`, documented there as `Decimal.js`. Anything that reads a balance gets that API.
3. **The currencies have different scales.** ARS, USD and BRL use 2 decimals, USDT uses 6, and the database keeps 8.

## Decision

- Money is an immutable `Money` value object holding an exact decimal and a currency, inseparable. The constructor is private; the only entry points are `Money.of` (client input, validated), `Money.zero` and `Money.restore` (already-stored values).
- `Money.of` rejects anything that is not plain decimal notation (no `1e400`, no `NaN`) and anything with more decimals than the currency allows (`PrecisionError`, which carries the currency and the limit).
- Arithmetic never mixes currencies (`CurrencyMismatchError`).
- Conversion between currencies **truncates** (`ROUND_DOWN`) to the target precision. Rounding to nearest can credit a fraction of a cent that was never exchanged; truncation only ever discards value.
- `Money.restore` loads a persisted amount **without** enforcing today's precision. Storage may hold amounts written before the rule existed (for example `1.0005 USD`), and refusing to load them would make a wallet that works today fail on read.
- The library is `decimal.js`, used **only** inside `money.ts`.
- The boundary with Prisma is a `string`: `new Prisma.Decimal(money.toString())` to write, `Money.restore(row.balance.toString(), currency)` to read. No code depends on the two `Decimal` classes being interchangeable.

## Why decimal.js

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
