import {
  ConflictException,
  Inject,
  Injectable,
  UnprocessableEntityException,
} from "@nestjs/common";
import { AmountTooLargeError } from "../../../shared/kernel/money";
import { DepositInterface } from "../interfaces/wallet.interface";
import { UNIT_OF_WORK } from "./ports/unit-of-work.port";
import type { UnitOfWork } from "./ports/unit-of-work.port";
import { completeIdempotency } from "./complete-idempotency";
import { toMoney } from "./to-money";

@Injectable()
export class DepositService {
  constructor(@Inject(UNIT_OF_WORK) private readonly unitOfWork: UnitOfWork) {}

  async execute({
    userId,
    currency,
    amount,
    description,
    idempotency,
  }: DepositInterface) {
    const money = toMoney(amount, currency);

    return this.unitOfWork.run(
      async ({ wallets, transactions, outbox, idempotency: records }) => {
        const wallet = await wallets.findOrCreateEmpty(userId, currency);

        // The database increments the balance on its own, so Money never sees
        // the result. Adding here makes the ceiling a business answer (422)
        // instead of a numeric overflow from Postgres (500).
        try {
          wallet.balance.add(money);
        } catch (error) {
          if (error instanceof AmountTooLargeError) {
            throw new UnprocessableEntityException(
              "The resulting balance would exceed the maximum allowed",
            );
          }
          throw error;
        }

        const applied = await wallets.credit(wallet.id, wallet.version, money);
        if (!applied) {
          throw new ConflictException("Optimistic lock conflict");
        }

        const transaction = await transactions.create({
          walletId: wallet.id,
          type: "DEPOSIT",
          status: "COMPLETED",
          amount: money,
          description: description ?? `Depósito ${currency}`,
        });

        // Same transaction as the balance change: the event exists if and only
        // if the deposit does. Delivery happens later, outside the request.
        await outbox.enqueue({
          type: "deposit.confirmed",
          walletId: wallet.id,
          data: {
            walletId: wallet.id,
            userId,
            amount,
            currency,
            transactionId: transaction.id,
          },
        });

        return completeIdempotency(records, idempotency, transaction);
      },
    );
  }
}
