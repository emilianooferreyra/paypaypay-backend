import { randomUUID } from "node:crypto";
import { InMemoryIdempotencyStore } from "../../idempotency/testing/in-memory-idempotency-store";
import type { IdempotencyContext } from "../../idempotency/application/ports/idempotency-store.port";
import { Currency, Money } from "../../../shared/kernel/money";
import {
  BeneficiaryReader,
  BeneficiarySnapshot,
} from "../application/ports/beneficiary.reader";
import { WalletEvent } from "../domain/wallet-events";
import { OutboxPort } from "../application/ports/outbox.port";
import {
  NewTransaction,
  TransactionRecord,
  TransactionRepository,
} from "../application/ports/transaction.repository";
import { UnitOfWork, WalletTx } from "../application/ports/unit-of-work.port";
import {
  WalletRepository,
  WalletSnapshot,
} from "../application/ports/wallet.repository";

interface StoredWallet {
  id: string;
  userId: string;
  currency: Currency;
  balance: Money;
  version: number;
}

/**
 * In-memory stand-in for the wallet persistence ports. It keeps the two
 * properties the use cases rely on: a `run` commits all or nothing, and a
 * credit or debit is a compare-and-swap on `version`.
 *
 * It does not retry: retrying is the adapter's job and is covered by the
 * integration test against Postgres. Here a stale version simply resolves
 * `false`, which is what the use case has to react to.
 */
export class InMemoryUnitOfWork implements UnitOfWork {
  private wallets = new Map<string, StoredWallet>();
  private records: TransactionRecord[] = [];
  private conflictsToInject = 0;
  private failNextCreate: Error | null = null;
  private failNextEnqueue: Error | null = null;
  private enqueued: WalletEvent[] = [];

  /** The idempotency records, rolled back together with the money. */
  readonly idempotencyStore = new InMemoryIdempotencyStore();

  /** Claims a key the way the interceptor does, returning the proof of ownership. */
  async claimKey(
    key = randomUUID(),
    userId = "u1",
  ): Promise<IdempotencyContext> {
    const claim = await this.idempotencyStore.claim({
      userId,
      key,
      route: "/wallet",
      requestHash: "hash",
      leaseMs: 60_000,
    });
    if (!claim.claimed) throw new Error("the key was already claimed");

    return claim.context;
  }

  seedWallet(input: {
    userId: string;
    currency: Currency;
    balance: string;
    version?: number;
  }): StoredWallet {
    const wallet: StoredWallet = {
      id: randomUUID(),
      userId: input.userId,
      currency: input.currency,
      balance: Money.restore(input.balance, input.currency),
      version: input.version ?? 1,
    };
    this.wallets.set(wallet.id, wallet);
    return wallet;
  }

  /** The next `count` credits/debits report a stale version, changing nothing. */
  injectVersionConflicts(count: number): void {
    this.conflictsToInject = count;
  }

  /** The next transaction insert throws, after any wallet write already done. */
  injectTransactionFailure(error: Error): void {
    this.failNextCreate = error;
  }

  /** The next event enqueue throws, after the wallet and record were written. */
  injectOutboxFailure(error: Error): void {
    this.failNextEnqueue = error;
  }

  /** Events committed so far, in the order they were enqueued. */
  get outboxEvents(): readonly WalletEvent[] {
    return this.enqueued;
  }

  walletOf(userId: string, currency: Currency): StoredWallet | undefined {
    return [...this.wallets.values()].find(
      (w) => w.userId === userId && w.currency === currency,
    );
  }

  get transactions(): readonly TransactionRecord[] {
    return this.records;
  }

  async run<T>(work: (tx: WalletTx) => Promise<T>): Promise<T> {
    const walletsBefore = new Map(
      [...this.wallets].map(([id, w]) => [id, { ...w }]),
    );
    const recordsBefore = [...this.records];
    const eventsBefore = [...this.enqueued];
    const idempotencyBefore = this.idempotencyStore.snapshot();

    try {
      return await work({
        wallets: this.walletRepository(),
        transactions: this.transactionRepository(),
        outbox: this.outboxPort(),
        idempotency: this.idempotencyStore,
      });
    } catch (error) {
      this.wallets = walletsBefore;
      this.records = recordsBefore;
      this.enqueued = eventsBefore;
      this.idempotencyStore.restore(idempotencyBefore);
      throw error;
    }
  }

  private toSnapshot(w: StoredWallet): WalletSnapshot {
    return { ...w };
  }

  private walletRepository(): WalletRepository {
    return {
      findByUserAndCurrency: (userId, currency) =>
        Promise.resolve(
          this.walletOf(userId, currency)
            ? this.toSnapshot(this.walletOf(userId, currency) as StoredWallet)
            : null,
        ),

      findOrCreateEmpty: (userId, currency) => {
        const existing = this.walletOf(userId, currency);
        if (existing) return Promise.resolve(this.toSnapshot(existing));

        const created = this.seedWallet({ userId, currency, balance: "0" });
        return Promise.resolve(this.toSnapshot(created));
      },

      credit: (walletId, expectedVersion, amount) =>
        Promise.resolve(this.swap(walletId, expectedVersion, amount, "add")),

      debit: (walletId, expectedVersion, amount) =>
        Promise.resolve(
          this.swap(walletId, expectedVersion, amount, "subtract"),
        ),
    };
  }

  private swap(
    walletId: string,
    expectedVersion: number,
    amount: Money,
    op: "add" | "subtract",
  ): boolean {
    const wallet = this.wallets.get(walletId);
    if (!wallet || wallet.version !== expectedVersion) return false;

    if (this.conflictsToInject > 0) {
      this.conflictsToInject -= 1;
      return false;
    }

    wallet.balance =
      op === "add"
        ? wallet.balance.add(amount)
        : wallet.balance.subtract(amount);
    wallet.version += 1;
    return true;
  }

  private outboxPort(): OutboxPort {
    return {
      enqueue: (event) => {
        if (this.failNextEnqueue) {
          const error = this.failNextEnqueue;
          this.failNextEnqueue = null;
          return Promise.reject(error);
        }

        this.enqueued.push(event);
        return Promise.resolve();
      },
    };
  }

  private transactionRepository(): TransactionRepository {
    return {
      create: (input: NewTransaction) => {
        if (this.failNextCreate) {
          const error = this.failNextCreate;
          this.failNextCreate = null;
          return Promise.reject(error);
        }

        const record: TransactionRecord = {
          id: randomUUID(),
          walletId: input.walletId,
          toWalletId: null,
          type: input.type,
          amount: input.amount.toString(),
          currency: input.amount.getCurrency(),
          status: input.status,
          description: input.description,
          category: null,
          metadata: input.metadata ?? null,
          reversesTransactionId: null,
          createdAt: new Date(),
        };
        this.records.push(record);
        return Promise.resolve(record);
      },
    };
  }
}

export class InMemoryBeneficiaryReader implements BeneficiaryReader {
  private readonly byKey = new Map<string, BeneficiarySnapshot>();

  add(userId: string, beneficiary: BeneficiarySnapshot): void {
    this.byKey.set(`${userId}:${beneficiary.id}`, beneficiary);
  }

  findActive(
    userId: string,
    beneficiaryId: string,
  ): Promise<BeneficiarySnapshot | null> {
    return Promise.resolve(
      this.byKey.get(`${userId}:${beneficiaryId}`) ?? null,
    );
  }
}
