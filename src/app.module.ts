import { Module } from "@nestjs/common";
import { CacheModule } from "@nestjs/cache-manager";
import { EventEmitterModule } from "@nestjs/event-emitter";
import { ThrottlerModule, ThrottlerGuard } from "@nestjs/throttler";
import { APP_GUARD } from "@nestjs/core";
import { LoggerModule } from "nestjs-pino";
import { PrismaModule } from "./modules/prisma/prisma.module";
import KeyvRedis from "@keyv/redis";
import { envs } from "./config";
import { UsersModule } from "./modules/users/users.module";
import { HashModule } from "./modules/hash/hash.module";
import { SessionModule } from "./modules/session/session.module";
import { TokensModule } from "./modules/tokens/tokens.module";
import { EmailsModule } from "./modules/emails/emails.module";
import { AuthModule } from "./modules/auth/auth.module";
import { WalletModule } from "./modules/wallet/wallet.module";
import { TransactionModule } from "./modules/transaction/transaction.module";
import { InvestmentModule } from "./modules/investment/investment.module";
import { CardModule } from "./modules/card/card.module";
import { ExchangeRateModule } from "./modules/exchange-rate/exchange-rate.module";
import { KycModule } from "./modules/kyc/kyc.module";
import { WebhookModule } from "./modules/webhook/webhook.module";
import { BeneficiariesModule } from "./modules/beneficiaries/beneficiaries.module";
import { HealthModule } from "./modules/health/health.module";
import { PricesModule } from "./modules/prices/prices.module";
import { PortfolioModule } from "./modules/portfolio/portfolio.module";
import { BrokersModule } from "./modules/brokers/brokers.module";
import { IdempotencyModule } from "./modules/idempotency/idempotency.module";
import { CsrfGuard } from "./common/guards/csrf.guard";

@Module({
  imports: [
    EventEmitterModule.forRoot(),
    ThrottlerModule.forRoot([{ ttl: 60000, limit: 60 }]),
    CacheModule.registerAsync({
      isGlobal: true,
      useFactory: () => ({
        ttl: 5000,
        stores: [new KeyvRedis(envs.REDIS_URL)],
      }),
    }),
    LoggerModule.forRoot({
      pinoHttp: {
        transport:
          process.env.NODE_ENV !== "production"
            ? { target: "pino-pretty" }
            : undefined,
        level: process.env.LOG_LEVEL ?? "info",
        autoLogging: false,
      },
    }),
    PrismaModule,
    UsersModule,
    HashModule,
    SessionModule,
    TokensModule,
    EmailsModule,
    AuthModule,
    WalletModule,
    TransactionModule,
    InvestmentModule,
    CardModule,
    ExchangeRateModule,
    KycModule,
    WebhookModule,
    BeneficiariesModule,
    HealthModule,
    PricesModule,
    PortfolioModule,
    BrokersModule,
    IdempotencyModule,
  ],
  controllers: [],
  providers: [
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: CsrfGuard },
  ],
})
export class AppModule {}
