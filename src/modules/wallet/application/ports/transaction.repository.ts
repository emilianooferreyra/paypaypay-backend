import { Currency, Money } from "../../../../shared/kernel/money";

export type TransactionType = "DEPOSIT" | "WITHDRAWAL" | "TRANSFER";

export type TransactionStatus =
  | "PENDING"
  | "COMPLETED"
  | "FAILED"
  | "CANCELLED"
  | "REVERSED";

export type TransactionMetadata = Readonly<
  Record<string, string | number | boolean | null>
>;

export interface NewTransaction {
  readonly walletId: string;
  readonly type: TransactionType;
  readonly status: TransactionStatus;
  /** Carries the currency too. */
  readonly amount: Money;
  readonly description: string;
  readonly metadata?: TransactionMetadata;
}

/**
 * The persisted row as the API returns it today. `amount` is a string because
 * that is how a Decimal already serializes, so responses stay identical.
 */
export interface TransactionRecord {
  readonly id: string;
  readonly walletId: string;
  readonly toWalletId: string | null;
  readonly type: string;
  readonly amount: string;
  readonly currency: Currency;
  readonly status: string;
  readonly description: string | null;
  readonly category: string | null;
  readonly metadata: unknown;
  readonly reversesTransactionId: string | null;
  readonly createdAt: Date;
}

export interface TransactionRepository {
  create(transaction: NewTransaction): Promise<TransactionRecord>;
}
