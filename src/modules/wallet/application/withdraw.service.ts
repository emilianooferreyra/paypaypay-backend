import {
  ConflictException,
  Inject,
  Injectable,
  UnprocessableEntityException,
} from "@nestjs/common";
import { assertFound } from "../../../common/utils/assert-found";
import { WithdrawInterface } from "../interfaces/wallet.interface";
import { UNIT_OF_WORK } from "./ports/unit-of-work.port";
import type { UnitOfWork } from "./ports/unit-of-work.port";
import { completeIdempotency } from "./complete-idempotency";
import { toMoney } from "./to-money";

@Injectable()
export class WithdrawService {
  constructor(@Inject(UNIT_OF_WORK) private readonly unitOfWork: UnitOfWork) {}

  async execute({
    userId,
    currency,
    amount,
    description,
    idempotency,
  }: WithdrawInterface) {
    const money = toMoney(amount, currency);

    return this.unitOfWork.run(
      async ({ wallets, transactions, outbox, idempotency: records }) => {
        const wallet = await wallets.findByUserAndCurrency(userId, currency);

        assertFound(wallet, `Wallet ${currency}`);

        if (wallet.balance.isLessThan(money)) {
          throw new UnprocessableEntityException("Insufficient balance");
        }

        const applied = await wallets.debit(wallet.id, wallet.version, money);
        if (!applied) {
          throw new ConflictException("Optimistic lock conflict");
        }

        const transaction = await transactions.create({
          walletId: wallet.id,
          type: "WITHDRAWAL",
          status: "COMPLETED",
          amount: money,
          description: description ?? `Retiro ${currency}`,
        });

        await outbox.enqueue({
          type: "withdraw.completed",
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
