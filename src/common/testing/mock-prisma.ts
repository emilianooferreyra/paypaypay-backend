import { PrismaClient } from "../../generated/prisma/client.js";

type MockedModel = {
  [K in
    | "findUnique"
    | "findFirst"
    | "findMany"
    | "create"
    | "createMany"
    | "update"
    | "upsert"
    | "delete"
    | "deleteMany"
    | "updateMany"
    | "count"
    | "aggregate"
    | "groupBy"]: jest.Mock;
};

type MockedPrisma = {
  [K in keyof PrismaClient]: K extends
    | "$transaction"
    | "$connect"
    | "$disconnect"
    | "$on"
    | "$use"
    | "$extends"
    ? jest.Mock
    : MockedModel;
};

const createMockedModel = (): MockedModel => ({
  findUnique: jest.fn(),
  findFirst: jest.fn(),
  findMany: jest.fn(),
  create: jest.fn(),
  createMany: jest.fn(),
  update: jest.fn(),
  upsert: jest.fn(),
  delete: jest.fn(),
  deleteMany: jest.fn(),
  updateMany: jest.fn(),
  count: jest.fn(),
  aggregate: jest.fn(),
  groupBy: jest.fn(),
});

const mockPrisma = {
  user: createMockedModel(),
  session: createMockedModel(),
  wallet: createMockedModel(),
  transaction: createMockedModel(),
  asset: createMockedModel(),
  investment: createMockedModel(),
  card: createMockedModel(),
  exchangeRate: createMockedModel(),
  kycVerification: createMockedModel(),
  auditLog: createMockedModel(),
  userBackupCode: createMockedModel(),
  beneficiary: createMockedModel(),
  webhookEndpoint: createMockedModel(),
  webhookDelivery: createMockedModel(),
  portfolio: createMockedModel(),
  portfolioAsset: createMockedModel(),
  broker: createMockedModel(),
  $transaction: jest.fn(),
  $connect: jest.fn(),
  $disconnect: jest.fn(),
  $on: jest.fn(),
  $use: jest.fn(),
  $extends: jest.fn(),
} as unknown as MockedPrisma;

export { mockPrisma };
export type { MockedPrisma };
