import { ConflictException } from "@nestjs/common";
import {
  InMemoryBeneficiaryReader,
  InMemoryUnitOfWork,
} from "../testing/in-memory-unit-of-work";
import type { IdempotencyContext } from "../../idempotency/application/ports/idempotency-store.port";
import { DepositService } from "./deposit.service";
import { SendService } from "./send.service";
import { WithdrawService } from "./withdraw.service";

type Run = (
  idempotency: IdempotencyContext | undefined,
) => Promise<{ id: string }>;

describe("completing the idempotency record inside the money transaction", () => {
  let uow: InMemoryUnitOfWork;
  let beneficiaries: InMemoryBeneficiaryReader;

  beforeEach(() => {
    uow = new InMemoryUnitOfWork();
    beneficiaries = new InMemoryBeneficiaryReader();
    beneficiaries.add("u1", {
      id: "b1",
      alias: "mi.alias",
      currency: "ARS",
      beneficiaryType: "ALIAS",
      accountNumber: "0000003100012345678901",
      bankName: "Banco Test",
    });
    uow.seedWallet({ userId: "u1", currency: "ARS", balance: "1000" });
  });

  const cases: [string, () => Run, string][] = [
    [
      "deposit",
      () => (idempotency) =>
        new DepositService(uow).execute({
          userId: "u1",
          currency: "ARS",
          amount: "500",
          idempotency,
        }),
      "1500.00",
    ],
    [
      "withdraw",
      () => (idempotency) =>
        new WithdrawService(uow).execute({
          userId: "u1",
          currency: "ARS",
          amount: "500",
          idempotency,
        }),
      "500.00",
    ],
    [
      "send",
      () => (idempotency) =>
        new SendService(uow, beneficiaries).execute({
          userId: "u1",
          beneficiaryId: "b1",
          amount: "500",
          idempotency,
        }),
      "500.00",
    ],
  ];

  describe.each(cases)("%s", (_name, makeRun, expectedBalance) => {
    it("completes the record with 201 and the response, together with the balance", async () => {
      const ctx = await uow.claimKey();

      const result = await makeRun()(ctx);

      const record = uow.idempotencyStore.records.get(ctx.recordId);
      expect(record?.status).toBe("COMPLETED");
      expect(record?.statusCode).toBe(201);
      expect(record?.response).toEqual(JSON.parse(JSON.stringify(result)));
      expect(uow.walletOf("u1", "ARS")?.balance.toString()).toBe(
        expectedBalance,
      );
    });

    it("does not complete the record when the work rolls back", async () => {
      const ctx = await uow.claimKey();
      uow.injectOutboxFailure(new Error("outbox down"));

      await expect(makeRun()(ctx)).rejects.toThrow("outbox down");

      expect(uow.idempotencyStore.records.get(ctx.recordId)?.status).toBe(
        "IN_PROGRESS",
      );
      expect(uow.walletOf("u1", "ARS")?.balance.toString()).toBe("1000.00");
    });

    it("rolls the money back when the holder lost its lease", async () => {
      const ctx = await uow.claimKey();
      const stale = { ...ctx, lockToken: "taken-over" };

      await expect(makeRun()(stale)).rejects.toBeInstanceOf(ConflictException);

      expect(uow.walletOf("u1", "ARS")?.balance.toString()).toBe("1000.00");
      expect(uow.transactions).toHaveLength(0);
      expect(uow.outboxEvents).toHaveLength(0);
    });

    it("still works without a key, for callers that are not HTTP requests", async () => {
      await expect(makeRun()(undefined)).resolves.toBeDefined();
    });
  });
});
