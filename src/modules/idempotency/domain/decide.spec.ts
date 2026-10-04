import { ExistingRecord, decide } from "./decide";

const FP = "fingerprint-1";

const record = (overrides: Partial<ExistingRecord> = {}): ExistingRecord => ({
  status: "IN_PROGRESS",
  requestHash: FP,
  statusCode: null,
  response: null,
  leaseExpired: false,
  retryAfterSeconds: 12,
  ...overrides,
});

describe("decide", () => {
  it("claims a key nobody has used", () => {
    expect(decide(null, FP)).toEqual({ action: "claim" });
  });

  describe("a request that already finished", () => {
    it("replays the stored success", () => {
      const done = record({
        status: "COMPLETED",
        statusCode: 201,
        response: { id: "tx-1" },
      });

      expect(decide(done, FP)).toEqual({
        action: "replay",
        statusCode: 201,
        body: { id: "tx-1" },
        failed: false,
      });
    });

    it("replays a stored deterministic failure, marked as a failure", () => {
      const failed = record({
        status: "FAILED",
        statusCode: 422,
        response: { message: "Insufficient balance" },
      });

      expect(decide(failed, FP)).toEqual({
        action: "replay",
        statusCode: 422,
        body: { message: "Insufficient balance" },
        failed: true,
      });
    });
  });

  describe("a request still running", () => {
    it("answers a conflict while the lease is alive, telling when to retry", () => {
      expect(decide(record({ retryAfterSeconds: 7 }), FP)).toEqual({
        action: "conflict",
        retryAfterSeconds: 7,
      });
    });

    it("never tells a client to retry in less than a second", () => {
      expect(decide(record({ retryAfterSeconds: 0 }), FP)).toEqual({
        action: "conflict",
        retryAfterSeconds: 1,
      });
    });

    it("takes the key over once the lease has expired", () => {
      expect(decide(record({ leaseExpired: true }), FP)).toEqual({
        action: "takeover",
      });
    });
  });

  describe("a different request under the same key", () => {
    it("is refused when the original finished", () => {
      const done = record({
        status: "COMPLETED",
        statusCode: 201,
        response: {},
      });

      expect(decide(done, "other")).toEqual({ action: "mismatch" });
    });

    it("is refused when the original is still running", () => {
      expect(decide(record(), "other")).toEqual({ action: "mismatch" });
    });

    it("is refused even when the original's lease expired", () => {
      expect(decide(record({ leaseExpired: true }), "other")).toEqual({
        action: "mismatch",
      });
    });
  });

  describe("rows written before the upgrade (no stored fingerprint)", () => {
    it("replays the response they stored", () => {
      const legacy = record({
        requestHash: null,
        statusCode: 201,
        response: { id: "old" },
      });

      expect(decide(legacy, FP)).toEqual({
        action: "replay",
        statusCode: 201,
        body: { id: "old" },
        failed: false,
      });
    });

    it("are taken over when they never stored a response", () => {
      const legacy = record({ requestHash: null, leaseExpired: true });

      expect(decide(legacy, FP)).toEqual({ action: "takeover" });
    });
  });
});
