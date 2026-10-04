import { Currency } from "../../../shared/kernel/money";

export type WalletEventType =
  | "deposit.confirmed"
  | "withdraw.completed"
  | "transfer.completed";

export interface WalletEventData {
  readonly walletId: string;
  readonly userId: string;
  /** The amount exactly as the client sent it. */
  readonly amount: string;
  readonly currency: Currency;
  readonly transactionId: string;
}

/**
 * Something that happened to a wallet. The wallet id is the aggregate id: the
 * outbox keeps events of one wallet in commit order, so a receiver never sees
 * a withdrawal before the deposit it depended on.
 */
export interface WalletEvent {
  readonly type: WalletEventType;
  readonly walletId: string;
  readonly data: WalletEventData;
}
