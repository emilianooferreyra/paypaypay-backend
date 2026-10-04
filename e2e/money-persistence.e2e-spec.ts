import { randomUUID } from "node:crypto";
import { INestApplication } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import request from "supertest";
import { PrismaService } from "../src/modules/prisma/prisma.service";
import { Prisma } from "../src/generated/prisma/client.js";
import { setupE2eApp } from "./setup-app";
import { cleanDatabase } from "./db-cleanup";

const USER_ID = "money-user-id";
const BASE = "/api/v1/wallet";

describe("Money at the persistence boundary (e2e)", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let accessToken: string;

  beforeAll(async () => {
    const { app: a, moduleFixture } = await setupE2eApp();
    app = a;
    prisma = moduleFixture.get(PrismaService);
    accessToken = moduleFixture
      .get(JwtService)
      .sign({ sub: USER_ID, sessionId: "money-session-id" });
  });

  afterAll(async () => {
    await prisma.$disconnect();
    await app.close();
  });

  beforeEach(async () => {
    await cleanDatabase(prisma);
    await prisma.user.create({
      data: {
        id: USER_ID,
        email: "money@test.com",
        password: "hashed",
        name: "Money",
        status: "ACTIVE",
        authProvider: "LOCAL",
      },
    });
    await prisma.session.create({
      data: {
        id: "money-session-id",
        userId: USER_ID,
        refreshToken: "hashed-refresh-token",
        isActive: true,
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      },
    });
    await prisma.kycVerification.create({
      data: { userId: USER_ID, status: "APPROVED" },
    });
  });

  const wallet = (currency: "ARS" | "USD", balance: string) =>
    prisma.wallet.create({
      data: {
        userId: USER_ID,
        currency,
        balance: new Prisma.Decimal(balance),
        version: 1,
      },
    });

  const post = (path: string, body: Record<string, string>) =>
    request(app.getHttpServer())
      .post(`${BASE}/${path}`)
      .set("Cookie", `access_token=${accessToken}`)
      .set("Idempotency-Key", randomUUID())
      .send(body);

  const balanceOf = async (currency: "ARS" | "USD") =>
    (
      await prisma.wallet.findUniqueOrThrow({
        where: { userId_currency: { userId: USER_ID, currency } },
      })
    ).balance.toFixed(8);

  describe("a wallet holding dust smaller than 0.000001", () => {
    // Prisma's Decimal prints these as 1e-7, 1e-8 and 5e-8. Reading the balance
    // through toString() made Money reject it, so the wallet could not be used.
    it.each([
      ["0.0000001", "1.00000010"],
      ["0.00000001", "1.00000001"],
      ["0.00000005", "1.00000005"],
    ])(
      "can be loaded: balance %s, after depositing 1.00",
      async (dust, expected) => {
        await wallet("USD", dust);

        await post("deposit", { amount: "1.00", currency: "USD" }).expect(201);

        expect(await balanceOf("USD")).toBe(expected);
      },
    );
  });

  describe("a balance with precision older than the currency rule", () => {
    it("still works: 1.0005 USD, withdrawing 1.00", async () => {
      await wallet("USD", "1.0005");

      await post("withdraw", { amount: "1.00", currency: "USD" }).expect(201);

      expect(await balanceOf("USD")).toBe("0.00050000");
    });

    it("cannot cover 1.01", async () => {
      await wallet("USD", "1.0005");

      await post("withdraw", { amount: "1.01", currency: "USD" }).expect(422);

      expect(await balanceOf("USD")).toBe("1.00050000");
    });
  });

  describe("the database ceiling of 10^12", () => {
    it("accepts the largest amount that fits", async () => {
      await post("deposit", {
        amount: "999999999999.99",
        currency: "ARS",
      }).expect(201);

      expect(await balanceOf("ARS")).toBe("999999999999.99000000");
    });

    it("answers 400, not 500, to an amount of 10^12", async () => {
      const res = await post("deposit", {
        amount: "1000000000000",
        currency: "ARS",
      }).expect(400);

      expect(JSON.stringify(res.body)).toMatch(/less than 1000000000000/);
    });

    it("answers 422, not 500, when the deposit would push the balance past the ceiling", async () => {
      await wallet("ARS", "999999999999.99");

      const res = await post("deposit", {
        amount: "0.02",
        currency: "ARS",
      }).expect(422);

      expect(JSON.stringify(res.body)).toMatch(/exceed/i);
      expect(await balanceOf("ARS")).toBe("999999999999.99000000");
    });
  });
});
