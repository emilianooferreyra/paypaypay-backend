import { Injectable } from "@nestjs/common";
import { PrismaService } from "../../../prisma/prisma.service";
import { withOptimisticRetry } from "../../utils/with-optimistic-retry";
import {
  UnitOfWork,
  WalletTx,
} from "../../application/ports/unit-of-work.port";
import { PrismaOutboxRepository } from "./prisma-outbox.repository";
import { PrismaTransactionRepository } from "./prisma-transaction.repository";
import { PrismaWalletRepository } from "./prisma-wallet.repository";

/**
 * One Prisma interactive transaction per `run`, with the retry policy the
 * money flows already had (READ COMMITTED, version compare-and-swap, bounded
 * retries on serialization failure, deadlock and unique violation). Only the
 * boundary moved: the application layer no longer sees Prisma.
 */
@Injectable()
export class PrismaUnitOfWork implements UnitOfWork {
  constructor(private readonly prisma: PrismaService) {}

  run<T>(work: (tx: WalletTx) => Promise<T>): Promise<T> {
    return withOptimisticRetry(this.prisma, (tx) =>
      work({
        wallets: new PrismaWalletRepository(tx),
        transactions: new PrismaTransactionRepository(tx),
        outbox: new PrismaOutboxRepository(tx),
      }),
    );
  }
}
