import {
  BadRequestException,
  ConflictException,
  NotFoundException,
  UnprocessableEntityException,
} from "@nestjs/common";
import { BeneficiarySnapshot } from "./ports/beneficiary.reader";
import {
  InMemoryBeneficiaryReader,
  InMemoryUnitOfWork,
} from "../testing/in-memory-unit-of-work";
import { SendService } from "./send.service";

const beneficiary: BeneficiarySnapshot = {
  id: "b1",
  alias: "mi.alias",
  currency: "ARS",
  beneficiaryType: "ALIAS",
  accountNumber: "0000003100012345678901",
  bankName: "Banco Test",
};

describe("SendService", () => {
  let uow: InMemoryUnitOfWork;
  let beneficiaries: InMemoryBeneficiaryReader;
  let service: SendService;

  beforeEach(() => {
    uow = new InMemoryUnitOfWork();
    beneficiaries = new InMemoryBeneficiaryReader();
    beneficiaries.add("u1", beneficiary);
    service = new SendService(uow, beneficiaries);
  });

  it("debits the wallet in the beneficiary currency and records a TRANSFER", async () => {
    uow.seedWallet({ userId: "u1", currency: "ARS", balance: "1000" });

    const result = await service.execute({
      userId: "u1",
      beneficiaryId: "b1",
      amount: "300",
    });

    expect(result.type).toBe("TRANSFER");
    expect(result.status).toBe("COMPLETED");
    expect(result.currency).toBe("ARS");
    expect(result.description).toBe("Envío a mi.alias");
    expect(uow.walletOf("u1", "ARS")?.balance.toString()).toBe("700.00");
  });

  it("stores a snapshot of the beneficiary on the transaction", async () => {
    uow.seedWallet({ userId: "u1", currency: "ARS", balance: "1000" });

    const result = await service.execute({
      userId: "u1",
      beneficiaryId: "b1",
      amount: "300",
    });

    expect(result.metadata).toEqual({
      beneficiaryId: "b1",
      beneficiaryAlias: "mi.alias",
      beneficiaryType: "ALIAS",
      accountNumber: "0000003100012345678901",
      bankName: "Banco Test",
    });
  });

  it("answers 404 when the beneficiary does not exist or belongs to someone else", async () => {
    uow.seedWallet({ userId: "u2", currency: "ARS", balance: "1000" });

    await expect(
      service.execute({ userId: "u2", beneficiaryId: "b1", amount: "10" }),
    ).rejects.toThrow(new NotFoundException("Beneficiary not found"));

    expect(uow.outboxEvents).toHaveLength(0);
  });

  it("answers 404 when there is no wallet in the beneficiary currency", async () => {
    await expect(
      service.execute({ userId: "u1", beneficiaryId: "b1", amount: "10" }),
    ).rejects.toThrow(new NotFoundException("Wallet ARS not found"));
  });

  it("answers 422 and writes nothing when the balance is not enough", async () => {
    uow.seedWallet({ userId: "u1", currency: "ARS", balance: "100" });

    await expect(
      service.execute({ userId: "u1", beneficiaryId: "b1", amount: "100.01" }),
    ).rejects.toThrow(new UnprocessableEntityException("Insufficient balance"));

    expect(uow.walletOf("u1", "ARS")?.balance.toString()).toBe("100.00");
    expect(uow.transactions).toHaveLength(0);
    expect(uow.outboxEvents).toHaveLength(0);
  });

  it("validates precision against the beneficiary currency", async () => {
    uow.seedWallet({ userId: "u1", currency: "ARS", balance: "1000" });

    await expect(
      service.execute({ userId: "u1", beneficiaryId: "b1", amount: "1.005" }),
    ).rejects.toThrow(BadRequestException);
  });

  it("fails with a conflict and writes nothing when the wallet version moved", async () => {
    uow.seedWallet({ userId: "u1", currency: "ARS", balance: "1000" });
    uow.injectVersionConflicts(1);

    await expect(
      service.execute({ userId: "u1", beneficiaryId: "b1", amount: "100" }),
    ).rejects.toThrow(ConflictException);

    expect(uow.walletOf("u1", "ARS")?.balance.toString()).toBe("1000.00");
    expect(uow.transactions).toHaveLength(0);
    expect(uow.outboxEvents).toHaveLength(0);
  });

  describe("outbox", () => {
    it("enqueues transfer.completed with the beneficiary currency", async () => {
      uow.seedWallet({ userId: "u1", currency: "ARS", balance: "1000" });

      const result = await service.execute({
        userId: "u1",
        beneficiaryId: "b1",
        amount: "300",
      });

      expect(uow.outboxEvents).toEqual([
        {
          type: "transfer.completed",
          walletId: result.walletId,
          data: {
            walletId: result.walletId,
            userId: "u1",
            amount: "300",
            currency: "ARS",
            transactionId: result.id,
          },
        },
      ]);
    });

    it("rolls back the debit and the record when the event cannot be enqueued", async () => {
      uow.seedWallet({ userId: "u1", currency: "ARS", balance: "1000" });
      uow.injectOutboxFailure(new Error("outbox down"));

      await expect(
        service.execute({ userId: "u1", beneficiaryId: "b1", amount: "300" }),
      ).rejects.toThrow("outbox down");

      expect(uow.walletOf("u1", "ARS")?.balance.toString()).toBe("1000.00");
      expect(uow.transactions).toHaveLength(0);
      expect(uow.outboxEvents).toHaveLength(0);
    });
  });
});
