import { WalletEvent } from "../../domain/wallet-events";

export interface OutboxPort {
  /**
   * Records the event in the same database transaction as the change that
   * caused it. It is published later by a relay, never from the request path.
   */
  enqueue(event: WalletEvent): Promise<void>;
}
