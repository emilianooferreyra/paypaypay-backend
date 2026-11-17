import {
  BadRequestException,
  ConflictException,
  Injectable,
  UnprocessableEntityException,
} from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { ExchangeInterface } from "./interfaces/wallet.interface";
import { Prisma } from "../../generated/prisma/client.js";
import { withOptimisticRetry } from "./utils/with-optimistic-retry";
import { validateCurrencyPrecision } from "./utils/validate-currency-precision";
import { envs } from "../../config/envs";
import { PrismaIdempotencyPort } from "../idempotency/infrastructure/prisma-idempotency.port";
import { completeIdempotency } from "./application/complete-idempotency";
import { assertFound } from "../../common/utils/assert-found";

@Injectable()
export class ExchangeService {
  constructor(private readonly prisma: PrismaService) {}

  async execute({
    userId,
    fromCurrency,
    toCurrency,
    amount,
    idempotency,
  }: ExchangeInterface) {
    if (fromCurrency === toCurrency) {
      throw new BadRequestException(
        "Source and destination currency must differ",
      );
    }

    const decimalAmount = new Prisma.Decimal(amount);
    validateCurrencyPrecision(fromCurrency, decimalAmount);

    return withOptimisticRetry(this.prisma, async (tx) => {
      // An interactive transaction runs on a single connection, so Promise.all
      // buys no parallelism here — it only hides the order of the queries.
      const sourceWallet = await tx.wallet.findUnique({
        where: { userId_currency: { userId, currency: fromCurrency } },
      });
      const targetWallet = await tx.wallet.findUnique({
        where: { userId_currency: { userId, currency: toCurrency } },
      });
      const exchangeRate = await tx.exchangeRate.findFirst({
        where: { fromCurrency, toCurrency },
        orderBy: { date: "desc" },
      });

      assertFound(sourceWallet, `Wallet ${fromCurrency}`);
      assertFound(targetWallet, `Wallet ${toCurrency}`);
      assertFound(exchangeRate, `Exchange rate ${fromCurrency}/${toCurrency}`);

      const rateAge = Date.now() - new Date(exchangeRate.date).getTime();
      if (rateAge > envs.EXCHANGE_RATE_MAX_AGE_MS) {
        throw new UnprocessableEntityException(
          `Exchange rate for ${fromCurrency}/${toCurrency} is stale. Please retry.`,
        );
      }

      if (sourceWallet.balance.lessThan(decimalAmount)) {
        throw new UnprocessableEntityException("Insufficient balance");
      }

      const rate = new Prisma.Decimal(exchangeRate.rate);
      const received = decimalAmount.times(rate);

      // Two opposite exchanges (USD->ARS and ARS->USD) would take these row locks
      // in reverse order and deadlock. Sorting by wallet id makes the acquisition
      // order the same for every caller.
      const legs = [
        {
          wallet: sourceWallet,
          data: {
            balance: { decrement: decimalAmount },
            version: { increment: 1 },
          },
        },
        {
          wallet: targetWallet,
          data: {
            balance: { increment: received },
            version: { increment: 1 },
          },
        },
      ].sort((a, b) => a.wallet.id.localeCompare(b.wallet.id));

      for (const { wallet, data } of legs) {
        const { count } = await tx.wallet.updateMany({
          where: { id: wallet.id, version: wallet.version },
          data,
        });

        if (count === 0) {
          throw new ConflictException("Optimistic lock conflict");
        }
      }

      const transaction = await tx.transaction.create({
        data: {
          walletId: sourceWallet.id,
          toWalletId: targetWallet.id,
          type: "EXCHANGE",
          amount: decimalAmount,
          currency: fromCurrency,
          status: "COMPLETED",
          description: `Conversión ${fromCurrency} → ${toCurrency}`,
          metadata: {
            rate: rate.toString(),
            received: received.toString(),
            toCurrency,
          },
        },
      });

      // Last step of the transaction, so the stored response commits with the
      // balances or not at all.
      return completeIdempotency(new PrismaIdempotencyPort(tx), idempotency, {
        ...transaction,
        received,
        rate,
        toCurrency,
      });
    });
  }
}
