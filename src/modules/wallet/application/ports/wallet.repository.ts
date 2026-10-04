import { Currency, Money } from "../../../../shared/kernel/money";

export interface WalletSnapshot {
  readonly id: string;
  readonly userId: string | null;
  readonly currency: Currency;
  /** Restored, not validated: storage may hold precision older than the rules. */
  readonly balance: Money;
  readonly version: number;
}

export interface WalletRepository {
  findByUserAndCurrency(
    userId: string,
    currency: Currency,
  ): Promise<WalletSnapshot | null>;

  /**
   * Returns the user's wallet for that currency, creating an empty one if it
   * does not exist. Must not be a read followed by a create: two concurrent
   * first deposits would both miss the row and race on the unique constraint.
   */
  findOrCreateEmpty(
    userId: string,
    currency: Currency,
  ): Promise<WalletSnapshot>;

  /**
   * Compare-and-swap on `version`. Resolves `false` when the version moved
   * since the wallet was read, in which case nothing was written.
   */
  credit(
    walletId: string,
    expectedVersion: number,
    amount: Money,
  ): Promise<boolean>;

  debit(
    walletId: string,
    expectedVersion: number,
    amount: Money,
  ): Promise<boolean>;
}
