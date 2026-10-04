import { Prisma } from "../../../../generated/prisma/client.js";
import { OutboxPort } from "../../application/ports/outbox.port";
import { WalletEvent } from "../../domain/wallet-events";

const AGGREGATE_TYPE = "wallet";

export class PrismaOutboxRepository implements OutboxPort {
  constructor(private readonly tx: Prisma.TransactionClient) {}

  async enqueue(event: WalletEvent): Promise<void> {
    // Commit order per wallet. The lock is held until this transaction ends, so
    // a second writer for the same wallet waits here and only gets its `seq`
    // after the first has committed or rolled back. Without it, `seq` would
    // follow insert order while commits could land the other way round, and a
    // receiver could see a withdrawal before the deposit it depended on.
    // Writers of different wallets never wait for each other.
    await this.tx.$executeRaw`
      SELECT pg_advisory_xact_lock(hashtextextended(${`${AGGREGATE_TYPE}:${event.walletId}`}, 0))
    `;

    await this.tx.outboxEvent.create({
      data: {
        type: event.type,
        aggregateType: AGGREGATE_TYPE,
        aggregateId: event.walletId,
        payload: {
          walletId: event.data.walletId,
          userId: event.data.userId,
          amount: event.data.amount,
          currency: event.data.currency,
          transactionId: event.data.transactionId,
        },
        occurredAt: new Date(),
      },
    });
  }
}
