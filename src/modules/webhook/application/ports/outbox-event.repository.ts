export interface OutboxEventRecord {
  readonly id: string;
  readonly type: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly occurredAt: Date;
}

export interface OutboxEventRepository {
  /**
   * Locks and returns up to `limit` unprocessed events, oldest first by
   * sequence, skipping rows another relay already holds so that concurrent
   * relays work on disjoint batches.
   */
  claimUnprocessed(limit: number): Promise<OutboxEventRecord[]>;

  markProcessed(ids: readonly string[], at: Date): Promise<void>;
}
