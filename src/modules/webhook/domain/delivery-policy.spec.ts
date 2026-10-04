import {
  DEFAULT_RETRY_POLICY,
  DeliveryOutcome,
  RetryPolicy,
  classify,
  decide,
  retryDelayMs,
} from "./delivery-policy";

const noJitter = () => 0.5; // (0.5 * 2 - 1) = 0, so the base delay is used as is
const NOW = new Date("2026-09-30T12:00:00.000Z");

const response = (status: number): DeliveryOutcome => ({
  kind: "response",
  status,
});
const failure = (reason: string): DeliveryOutcome => ({
  kind: "failure",
  reason,
});

describe("classify", () => {
  it("treats any 2xx as delivered", () => {
    for (const status of [200, 201, 202, 204, 299]) {
      expect(classify(response(status))).toBe("delivered");
    }
  });

  it("retries server errors, request timeout and rate limiting", () => {
    for (const status of [408, 429, 500, 502, 503, 504]) {
      expect(classify(response(status))).toBe("retryable");
    }
  });

  it("treats other client errors as permanent", () => {
    for (const status of [400, 401, 403, 404, 410, 422]) {
      expect(classify(response(status))).toBe("permanent");
    }
  });

  it("treats redirects as permanent: following them could reach a host nobody registered", () => {
    for (const status of [301, 302, 307, 308]) {
      expect(classify(response(status))).toBe("permanent");
    }
  });

  it("retries network errors and timeouts", () => {
    expect(classify(failure("ECONNREFUSED"))).toBe("retryable");
    expect(classify(failure("timeout after 5000ms"))).toBe("retryable");
  });
});

describe("retryDelayMs", () => {
  it("uses 1, 5 and 15 minutes for the first three retries", () => {
    expect(retryDelayMs(1, noJitter)).toBe(60_000);
    expect(retryDelayMs(2, noJitter)).toBe(300_000);
    expect(retryDelayMs(3, noJitter)).toBe(900_000);
  });

  it("keeps using the last delay after the table ends", () => {
    expect(retryDelayMs(9, noJitter)).toBe(900_000);
  });

  it("spreads the delay by up to 20% in both directions", () => {
    expect(retryDelayMs(1, () => 0)).toBe(48_000); // -20%
    expect(retryDelayMs(1, () => 1)).toBe(72_000); // +20%
  });

  it("never returns a non-positive delay", () => {
    const aggressive: RetryPolicy = {
      ...DEFAULT_RETRY_POLICY,
      delaysMs: [1],
    };
    expect(retryDelayMs(1, () => 0, aggressive)).toBeGreaterThanOrEqual(1);
  });
});

describe("decide", () => {
  it("marks a 2xx as delivered and records the status", () => {
    expect(decide(0, response(200), NOW, noJitter)).toEqual({
      status: "delivered",
      attempts: 1,
      responseStatus: 200,
    });
  });

  it("schedules the next attempt about a minute ahead after the first retryable failure", () => {
    const decision = decide(0, response(503), NOW, noJitter);

    expect(decision).toEqual({
      status: "failed",
      attempts: 1,
      responseStatus: 503,
      lastError: "HTTP 503",
      nextRetryAt: new Date("2026-09-30T12:01:00.000Z"),
    });
  });

  it("waits five minutes after the second failure", () => {
    const decision = decide(1, failure("ECONNREFUSED"), NOW, noJitter);

    expect(decision).toMatchObject({
      status: "failed",
      attempts: 2,
      lastError: "ECONNREFUSED",
      nextRetryAt: new Date("2026-09-30T12:05:00.000Z"),
    });
  });

  it("gives up with a dead delivery once the attempts are exhausted", () => {
    const decision = decide(2, response(500), NOW, noJitter);

    expect(decision).toEqual({
      status: "dead",
      attempts: 3,
      responseStatus: 500,
      lastError: "HTTP 500",
    });
  });

  it("goes straight to dead on a permanent failure, without retrying", () => {
    expect(decide(0, response(400), NOW, noJitter)).toEqual({
      status: "dead",
      attempts: 1,
      responseStatus: 400,
      lastError: "HTTP 400",
    });
  });

  it("honors a different maximum number of attempts", () => {
    const policy: RetryPolicy = { ...DEFAULT_RETRY_POLICY, maxAttempts: 5 };

    expect(decide(2, response(500), NOW, noJitter, policy).status).toBe(
      "failed",
    );
    expect(decide(4, response(500), NOW, noJitter, policy).status).toBe("dead");
  });
});
