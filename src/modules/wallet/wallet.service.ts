import { Injectable } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import {
  DepositInterface,
  ExchangeInterface,
  SendInterface,
  WithdrawInterface,
} from "./interfaces/wallet.interface";
import { DepositService } from "./application/deposit.service";
import { WithdrawService } from "./application/withdraw.service";
import { ExchangeService } from "./exchange.service";
import { SendService } from "./application/send.service";

@Injectable()
export class WalletService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly depositService: DepositService,
    private readonly withdrawService: WithdrawService,
    private readonly exchangeService: ExchangeService,
    private readonly sendService: SendService,
  ) {}

  async getWallets(userId: string) {
    return this.prisma.wallet.findMany({
      where: { userId },
      orderBy: { currency: "asc" },
    });
  }

  async deposit(data: DepositInterface) {
    return this.depositService.execute(data);
  }

  async withdraw(data: WithdrawInterface) {
    return this.withdrawService.execute(data);
  }

  async exchange(data: ExchangeInterface) {
    return this.exchangeService.execute(data);
  }

  async send(data: SendInterface) {
    return this.sendService.execute(data);
  }
}
