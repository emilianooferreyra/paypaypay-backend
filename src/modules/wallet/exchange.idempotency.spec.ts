import { ConflictException } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { ExchangeService } from "./exchange.service";
import { PrismaService } from "../prisma/prisma.service";
import {
  makeWallet,
  mockPrisma,
  runTransactionsInline,
} from "../../common/testing";
import { Prisma } from "../../generated/prisma/client.js";
import { PrismaIdempotencyPort } from "../idempotency/infrastructure/prisma-idempotency.port";

const complete = jest.fn<Promise<boolean>, unknown[]>();
jest.mock("../idempotency/infrastructure/prisma-idempotency.port", () => ({
  PrismaIdempotencyPort: jest.fn().mockImplementation(() => ({ complete })),
}));

type WalletLookupArgs = { where: { userId_currency?: { currency: string } } };

describe("ExchangeService idempotency completion", () => {
  let service: ExchangeService;
  const context = { recordId: "rec-1", lockToken: "token-1" };
  const command = {
    userId: "user-1",
    fromCurrency: "ARS" as const,
    toCurrency: "USD" as const,
    amount: "500",
  };

  beforeEach(async () => {
    const module = await Test.createTestingModule({
      providers: [
        ExchangeService,
        { provide: PrismaService, useValue: mockPrisma },
      ],
    }).compile();
    service = module.get(ExchangeService);
    jest.clearAllMocks();
    jest.resetAllMocks();
    runTransactionsInline();
    (PrismaIdempotencyPort as unknown as jest.Mock).mockImplementation(() => ({
      complete,
    }));

    const source = makeWallet({
      balance: new Prisma.Decimal(1000),
      currency: "ARS",
    });
    const target = makeWallet({
      balance: new Prisma.Decimal(0),
      currency: "USD",
    });
    mockPrisma.wallet.findUnique.mockImplementation(
      ({ where }: WalletLookupArgs) =>
        Promise.resolve(
          where?.userId_currency?.currency === "ARS" ? source : target,
        ),
    );
    mockPrisma.exchangeRate.findFirst.mockResolvedValue({
      id: "rate-1",
      fromCurrency: "ARS",
      toCurrency: "USD",
      rate: new Prisma.Decimal("0.001"),
      date: new Date(),
    });
    mockPrisma.wallet.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.transaction.create.mockResolvedValue({
      id: "tx-1",
      walletId: source.id,
      toWalletId: target.id,
      type: "EXCHANGE",
      amount: "500",
      status: "COMPLETED",
    });
  });

  it("completes the record with 201 and the response inside the transaction", async () => {
    complete.mockResolvedValue(true);

    const result = await service.execute({ ...command, idempotency: context });

    expect(complete).toHaveBeenCalledTimes(1);
    expect(complete).toHaveBeenCalledWith(
      context,
      201,
      JSON.parse(JSON.stringify(result)),
    );
  });

  it("rolls the exchange back when the holder lost its lease", async () => {
    complete.mockResolvedValue(false);

    await expect(
      service.execute({ ...command, idempotency: context }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it("does not touch the record when nothing was claimed", async () => {
    await service.execute(command);

    expect(complete).not.toHaveBeenCalled();
  });
});
