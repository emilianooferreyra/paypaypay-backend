import { OutboxPort } from "./outbox.port";
import { TransactionRepository } from "./transaction.repository";
import { WalletRepository } from "./wallet.repository";

/** Repositories bound to one database transaction. */
export interface WalletTx {
  readonly wallets: WalletRepository;
  readonly transactions: TransactionRepository;
  readonly outbox: OutboxPort;
}

export interface UnitOfWork {
  /**
   * Runs `work` atomically: everything it writes through `tx` commits together
   * or not at all. The adapter owns the retry policy, so `work` may be invoked
   * more than once and must have no side effects except through `tx`.
   */
  run<T>(work: (tx: WalletTx) => Promise<T>): Promise<T>;
}

export const UNIT_OF_WORK = Symbol("UNIT_OF_WORK");
