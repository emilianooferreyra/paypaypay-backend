import { Test } from "@nestjs/testing";
import { WalletService } from "./wallet.service";
import { DepositService } from "./application/deposit.service";
import { WithdrawService } from "./application/withdraw.service";
import { ExchangeService } from "./exchange.service";
import { SendService } from "./application/send.service";
import { PrismaService } from "../prisma/prisma.service";
import { mockPrisma } from "../../common/testing";
import { CurrencyEnum } from "../../generated/prisma/enums";

describe("WalletService", () => {
  let service: WalletService;
  let depositService: jest.Mocked<DepositService>;
  let withdrawService: jest.Mocked<WithdrawService>;
  let exchangeService: jest.Mocked<ExchangeService>;
  let sendService: jest.Mocked<SendService>;

  beforeEach(async () => {
    depositService = { execute: jest.fn() } as any;
    withdrawService = { execute: jest.fn() } as any;
    exchangeService = { execute: jest.fn() } as any;
    sendService = { execute: jest.fn() } as any;

    const module = await Test.createTestingModule({
      providers: [
        WalletService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: DepositService, useValue: depositService },
        { provide: WithdrawService, useValue: withdrawService },
        { provide: ExchangeService, useValue: exchangeService },
        { provide: SendService, useValue: sendService },
      ],
    }).compile();
    service = module.get<WalletService>(WalletService);
  });

  describe("getWallets", () => {
    it("should return all wallets for a user", async () => {
      const wallets = [{ id: "w-1" }, { id: "w-2" }];
      mockPrisma.wallet.findMany.mockResolvedValue(wallets);

      const result = await service.getWallets("user-id");

      expect(result).toEqual(wallets);
    });

    it("should return empty array if no wallets", async () => {
      mockPrisma.wallet.findMany.mockResolvedValue([]);

      const result = await service.getWallets("user-id");

      expect(result).toEqual([]);
    });
  });

  describe("deposit", () => {
    it("should delegate to DepositService", async () => {
      const data = { userId: "u-1", currency: CurrencyEnum.ARS, amount: "500" };
      depositService.execute.mockResolvedValue({ id: "tx-1" } as any);

      const result = await service.deposit(data);

      expect(depositService.execute).toHaveBeenCalledWith(data);
      expect(result).toEqual({ id: "tx-1" });
    });
  });

  describe("withdraw", () => {
    it("should delegate to WithdrawService", async () => {
      const data = { userId: "u-1", currency: CurrencyEnum.ARS, amount: "500" };
      withdrawService.execute.mockResolvedValue({ id: "tx-1" } as any);

      const result = await service.withdraw(data);

      expect(withdrawService.execute).toHaveBeenCalledWith(data);
      expect(result).toEqual({ id: "tx-1" });
    });
  });

  describe("exchange", () => {
    it("should delegate to ExchangeService", async () => {
      const data = {
        userId: "u-1",
        fromCurrency: CurrencyEnum.ARS,
        toCurrency: CurrencyEnum.USD,
        amount: "500",
      };
      exchangeService.execute.mockResolvedValue({ id: "tx-1" } as any);

      const result = await service.exchange(data);

      expect(exchangeService.execute).toHaveBeenCalledWith(data);
      expect(result).toEqual({ id: "tx-1" });
    });
  });

  describe("send", () => {
    it("should delegate to SendService", async () => {
      const data = {
        userId: "u-1",
        beneficiaryId: "b-1",
        amount: "500",
      };
      sendService.execute.mockResolvedValue({ id: "tx-1" } as any);

      const result = await service.send(data);

      expect(sendService.execute).toHaveBeenCalledWith(data);
      expect(result).toEqual({ id: "tx-1" });
    });
  });
});
