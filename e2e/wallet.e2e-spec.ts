import { randomUUID } from "node:crypto";
import { INestApplication } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import request from "supertest";
import { PrismaService } from "../src/modules/prisma/prisma.service";
import { setupE2eApp } from "./setup-app";
import { cleanDatabase } from "./db-cleanup";

const BASE = "/api/v1/wallet";

describe("Wallet (e2e)", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let jwtService: JwtService;
  let accessToken: string;
  let walletId: string;

  beforeAll(async () => {
    const { app: a, moduleFixture } = await setupE2eApp();
    app = a;
    prisma = moduleFixture.get(PrismaService);
    jwtService = moduleFixture.get(JwtService);
  });

  afterAll(async () => {
    await prisma.$disconnect();
    await app.close();
  });

  beforeEach(async () => {
    await cleanDatabase(prisma);

    await prisma.user.create({
      data: {
        id: "wallet-user-id",
        email: "wallet@test.com",
        password: "hashed",
        name: "Wallet Test",
        status: "ACTIVE",
        authProvider: "LOCAL",
      },
    });

    await prisma.session.create({
      data: {
        id: "wallet-session-id",
        userId: "wallet-user-id",
        refreshToken: "hashed-refresh-token",
        isActive: true,
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      },
    });

    await prisma.kycVerification.create({
      data: {
        userId: "wallet-user-id",
        status: "APPROVED",
      },
    });

    accessToken = jwtService.sign({
      sub: "wallet-user-id",
      sessionId: "wallet-session-id",
    });
  });

  const authCookie = () => `access_token=${accessToken}`;

  describe("GET /wallet", () => {
    beforeEach(async () => {
      await prisma.wallet.create({
        data: {
          id: "wallet-ars-id",
          userId: "wallet-user-id",
          currency: "ARS",
          balance: 5000,
          version: 1,
        },
      });
      await prisma.wallet.create({
        data: {
          id: "wallet-usd-id",
          userId: "wallet-user-id",
          currency: "USD",
          balance: 100,
          version: 1,
        },
      });
    });

    it("should return wallets for authenticated user", async () => {
      const res = await request(app.getHttpServer())
        .get(BASE)
        .set("Cookie", authCookie())
        .expect(200);

      expect(res.body).toHaveLength(2);
    });

    it("should return 401 without auth cookie", async () => {
      await request(app.getHttpServer()).get(BASE).expect(401);
    });
  });

  describe("POST /wallet/deposit", () => {
    it("should deposit and create transaction", async () => {
      await prisma.wallet.create({
        data: {
          id: "deposit-wallet-id",
          userId: "wallet-user-id",
          currency: "ARS",
          balance: 1000,
          version: 1,
        },
      });

      const res = await request(app.getHttpServer())
        .post(`${BASE}/deposit`)
        .set("Cookie", authCookie())
        .set("Idempotency-Key", randomUUID())
        .send({ amount: "500", currency: "ARS" })
        .expect(201);

      expect(res.body.type).toBe("DEPOSIT");
    });

    it("should create wallet on first deposit", async () => {
      const res = await request(app.getHttpServer())
        .post(`${BASE}/deposit`)
        .set("Cookie", authCookie())
        .set("Idempotency-Key", randomUUID())
        .send({ amount: "500", currency: "ARS" })
        .expect(201);

      expect(res.body.type).toBe("DEPOSIT");
    });

    it("should return 400 for invalid amount", async () => {
      await request(app.getHttpServer())
        .post(`${BASE}/deposit`)
        .set("Cookie", authCookie())
        .set("Idempotency-Key", randomUUID())
        .send({ amount: -100, currency: "ARS" })
        .expect(400);
    });
  });

  describe("POST /wallet/withdraw", () => {
    beforeEach(async () => {
      await prisma.wallet.create({
        data: {
          id: "withdraw-wallet-id",
          userId: "wallet-user-id",
          currency: "ARS",
          balance: 1000,
          version: 1,
        },
      });
    });

    it("should withdraw and create transaction", async () => {
      const res = await request(app.getHttpServer())
        .post(`${BASE}/withdraw`)
        .set("Cookie", authCookie())
        .set("Idempotency-Key", randomUUID())
        .send({ amount: "500", currency: "ARS" })
        .expect(201);

      expect(res.body.type).toBe("WITHDRAWAL");
    });

    it("should return 422 on insufficient balance", async () => {
      await request(app.getHttpServer())
        .post(`${BASE}/withdraw`)
        .set("Cookie", authCookie())
        .set("Idempotency-Key", randomUUID())
        .send({ amount: "9999", currency: "ARS" })
        .expect(422);
    });
  });
});
