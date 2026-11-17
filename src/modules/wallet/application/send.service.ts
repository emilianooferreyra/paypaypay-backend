import {
  ConflictException,
  Inject,
  Injectable,
  UnprocessableEntityException,
} from "@nestjs/common";
import { assertFound } from "../../../common/utils/assert-found";
import { SendInterface } from "../interfaces/wallet.interface";
import { BENEFICIARY_READER } from "./ports/beneficiary.reader";
import type { BeneficiaryReader } from "./ports/beneficiary.reader";
import { UNIT_OF_WORK } from "./ports/unit-of-work.port";
import type { UnitOfWork } from "./ports/unit-of-work.port";
import { completeIdempotency } from "./complete-idempotency";
import { toMoney } from "./to-money";

@Injectable()
export class SendService {
  constructor(
    @Inject(UNIT_OF_WORK) private readonly unitOfWork: UnitOfWork,
    @Inject(BENEFICIARY_READER)
    private readonly beneficiaries: BeneficiaryReader,
  ) {}

  async execute({ userId, beneficiaryId, amount, idempotency }: SendInterface) {
    const beneficiary = await this.beneficiaries.findActive(
      userId,
      beneficiaryId,
    );

    assertFound(beneficiary, "Beneficiary");

    const currency = beneficiary.currency;
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
          type: "TRANSFER",
          status: "COMPLETED",
          amount: money,
          description: `Envío a ${beneficiary.alias}`,
          metadata: {
            beneficiaryId: beneficiary.id,
            beneficiaryAlias: beneficiary.alias,
            beneficiaryType: beneficiary.beneficiaryType,
            accountNumber: beneficiary.accountNumber,
            bankName: beneficiary.bankName,
          },
        });

        await outbox.enqueue({
          type: "transfer.completed",
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
