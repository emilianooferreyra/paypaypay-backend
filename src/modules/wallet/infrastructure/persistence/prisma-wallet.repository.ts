import { Prisma } from "../../../../generated/prisma/client.js";
import { Currency, Money } from "../../../../shared/kernel/money";
import {
  WalletRepository,
  WalletSnapshot,
} from "../../application/ports/wallet.repository";

interface WalletRow {
  id: string;
  userId: string | null;
  currency: Currency;
  balance: Prisma.Decimal;
  version: number;
}

function toSnapshot(row: WalletRow): WalletSnapshot {
  return {
    id: row.id,
    userId: row.userId,
    currency: row.currency,
    // Restored, not parsed: a stored balance may carry more precision than the
    // currency allows today (legacy FX rounding), and it must still load.
    // toFixed, never toString: Prisma's Decimal prints anything below 1e-6 in
    // exponent notation ("1e-8"), which Money rightly refuses.
    balance: Money.restore(row.balance.toFixed(8), row.currency),
    version: row.version,
  };
}

export class PrismaWalletRepository implements WalletRepository {
  constructor(private readonly tx: Prisma.TransactionClient) {}

  async findByUserAndCurrency(
    userId: string,
    currency: Currency,
  ): Promise<WalletSnapshot | null> {
    const row = await this.tx.wallet.findUnique({
      where: { userId_currency: { userId, currency } },
    });

    return row === null ? null : toSnapshot(row);
  }

  async findOrCreateEmpty(
    userId: string,
    currency: Currency,
  ): Promise<WalletSnapshot> {
    // Prisma's upsert reads before it writes, so two concurrent first deposits
    // can both miss the row and race on the userId_currency unique constraint.
    // The loser gets P2002, which the unit of work retries.
    const row = await this.tx.wallet.upsert({
      where: { userId_currency: { userId, currency } },
      create: { userId, currency, balance: 0, version: 1 },
      update: {},
    });

    return toSnapshot(row);
  }

  credit(
    walletId: string,
    expectedVersion: number,
    amount: Money,
  ): Promise<boolean> {
    return this.compareAndSwap(walletId, expectedVersion, {
      increment: new Prisma.Decimal(amount.toLedgerString()),
    });
  }

  debit(
    walletId: string,
    expectedVersion: number,
    amount: Money,
  ): Promise<boolean> {
    return this.compareAndSwap(walletId, expectedVersion, {
      decrement: new Prisma.Decimal(amount.toLedgerString()),
    });
  }

  private async compareAndSwap(
    walletId: string,
    expectedVersion: number,
    balance: { increment: Prisma.Decimal } | { decrement: Prisma.Decimal },
  ): Promise<boolean> {
    const { count } = await this.tx.wallet.updateMany({
      where: { id: walletId, version: expectedVersion },
      data: { balance, version: { increment: 1 } },
    });

    return count === 1;
  }
}
