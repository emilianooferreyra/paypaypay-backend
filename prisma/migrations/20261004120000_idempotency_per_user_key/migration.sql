-- Keys are scoped per user: two users may send the same key independently.
DROP INDEX "IdempotencyRecord_key_key";

ALTER TABLE "IdempotencyRecord"
  ADD COLUMN "requestHash" TEXT,
  ADD COLUMN "lockToken" TEXT,
  ADD COLUMN "lockedUntil" TIMESTAMP(3);

CREATE UNIQUE INDEX "IdempotencyRecord_userId_key_key" ON "IdempotencyRecord"("userId", "key");
