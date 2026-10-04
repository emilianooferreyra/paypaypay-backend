import { Module } from "@nestjs/common";
import { WalletController } from "./infrastructure/wallet.controller";
import { WalletService } from "./wallet.service";
import { DepositService } from "./application/deposit.service";
import { WithdrawService } from "./application/withdraw.service";
import { ExchangeService } from "./exchange.service";
import { SendService } from "./application/send.service";
import { BENEFICIARY_READER } from "./application/ports/beneficiary.reader";
import { UNIT_OF_WORK } from "./application/ports/unit-of-work.port";
import { PrismaBeneficiaryReader } from "./infrastructure/persistence/prisma-beneficiary.reader";
import { PrismaUnitOfWork } from "./infrastructure/persistence/prisma-unit-of-work";
import { PrismaModule } from "../prisma/prisma.module";
import { KycModule } from "../kyc/kyc.module";
import { IdempotencyModule } from "../idempotency/idempotency.module";

@Module({
  imports: [PrismaModule, KycModule, IdempotencyModule],
  controllers: [WalletController],
  providers: [
    WalletService,
    DepositService,
    WithdrawService,
    ExchangeService,
    SendService,
    // Ports bound to their Prisma adapters. Swapping persistence means changing
    // these two lines, not the use cases.
    { provide: UNIT_OF_WORK, useClass: PrismaUnitOfWork },
    { provide: BENEFICIARY_READER, useClass: PrismaBeneficiaryReader },
  ],
  exports: [WalletService],
})
export class WalletModule {}
