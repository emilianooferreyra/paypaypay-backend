import { Prisma } from "../../../../generated/prisma/client.js";
import {
  NewTransaction,
  TransactionRecord,
  TransactionRepository,
} from "../../application/ports/transaction.repository";

export class PrismaTransactionRepository implements TransactionRepository {
  constructor(private readonly tx: Prisma.TransactionClient) {}

  async create(transaction: NewTransaction): Promise<TransactionRecord> {
    const row = await this.tx.transaction.create({
      data: {
        walletId: transaction.walletId,
        type: transaction.type,
        amount: new Prisma.Decimal(transaction.amount.toLedgerString()),
        currency: transaction.amount.getCurrency(),
        status: transaction.status,
        description: transaction.description,
        metadata: transaction.metadata,
      },
    });

    // The API returns this row today, with `amount` serialized as a string.
    // Keeping every column and that shape keeps responses unchanged.
    return { ...row, amount: row.amount.toString() };
  }
}
