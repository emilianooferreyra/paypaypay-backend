import {
  BadRequestException,
  CallHandler,
  ConflictException,
  ExecutionContext,
  HttpException,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from "@nestjs/common";
import { defer, from, lastValueFrom } from "rxjs";
import { fingerprint } from "../domain/request-fingerprint";
import { IdempotencyContext } from "../application/ports/idempotency-store.port";
import { InMemoryIdempotencyStore } from "../testing/in-memory-idempotency-store";
import { IdempotencyInterceptor } from "./idempotency.interceptor";

interface FakeRequest {
  headers: Record<string, string | string[] | undefined>;
  method: string;
  route: { path: string };
  body: unknown;
  user: { userId: string };
  idempotency?: IdempotencyContext;
}

interface FakeResponse {
  statusCode: number;
  headers: Record<string, string>;
  status(code: number): FakeResponse;
  setHeader(name: string, value: string): void;
}

type Outcome = { ok: true; body: unknown } | { ok: false; error: unknown };

const LEASE_MS = 60_000;
const ROUTE = "/wallet/deposit";
const BODY = { amount: "500", currency: "ARS" };

const makeRequest = (overrides: Partial<FakeRequest> = {}): FakeRequest => ({
  headers: { "idempotency-key": "key-1" },
  method: "POST",
  route: { path: ROUTE },
  body: BODY,
  user: { userId: "user-1" },
  ...overrides,
});

const makeResponse = (): FakeResponse => {
  const response: FakeResponse = {
    statusCode: 201,
    headers: {},
    status(code) {
      response.statusCode = code;

      return response;
    },
    setHeader(name, value) {
      response.headers[name] = value;
    },
  };

  return response;
};

const contextFor = (
  request: FakeRequest,
  response: FakeResponse,
): ExecutionContext =>
  ({
    switchToHttp: () => ({
      getRequest: () => request,
      getResponse: () => response,
    }),
  }) as unknown as ExecutionContext;

const rejection = (outcome: Outcome): unknown => {
  if (outcome.ok) throw new Error("expected the request to be rejected");

  return outcome.error;
};

describe("IdempotencyInterceptor", () => {
  let store: InMemoryIdempotencyStore;
  let interceptor: IdempotencyInterceptor;
  let logged: Record<string, unknown>[];

  beforeEach(() => {
    store = new InMemoryIdempotencyStore();
    interceptor = new IdempotencyInterceptor(store, { leaseMs: LEASE_MS });
    logged = [];
    jest.spyOn(Logger.prototype, "log").mockImplementation((message) => {
      logged.push(JSON.parse(String(message)) as Record<string, unknown>);
    });
  });

  afterEach(() => jest.restoreAllMocks());

  const events = () => logged.map((e) => e.event);

  /** One request. `handler` plays the controller and may complete the record. */
  const send = async (
    handler: (ctx: IdempotencyContext) => unknown,
    requestOverrides: Partial<FakeRequest> = {},
  ) => {
    const request = makeRequest(requestOverrides);
    const response = makeResponse();
    const calls: IdempotencyContext[] = [];
    const next: CallHandler = {
      handle: () =>
        defer(() => {
          const ctx = request.idempotency as IdempotencyContext;
          calls.push(ctx);

          return from(Promise.resolve().then(() => handler(ctx)));
        }),
    };

    const outcome: Outcome = await interceptor
      .intercept(contextFor(request, response), next)
      .then((stream) => lastValueFrom(stream))
      .then(
        (body) => ({ ok: true, body }),
        (error: unknown) => ({ ok: false, error }),
      );

    return { request, response, calls, outcome };
  };

  const succeeding = (body: unknown) => async (ctx: IdempotencyContext) => {
    await store.complete(ctx, 201, body);

    return body;
  };

  const mustNotRun = () => {
    throw new Error("the handler must not run");
  };

  describe("the key header", () => {
    it("refuses a missing key and never reaches the handler", async () => {
      const { calls, outcome } = await send(mustNotRun, { headers: {} });

      expect(calls).toHaveLength(0);
      expect(rejection(outcome)).toBeInstanceOf(BadRequestException);
      expect(store.records.size).toBe(0);
    });

    it.each(["", "a b", "a\nb", "a".repeat(256)])(
      "refuses the malformed key %j",
      async (key) => {
        const { calls, outcome } = await send(mustNotRun, {
          headers: { "idempotency-key": key },
        });

        expect(calls).toHaveLength(0);
        expect(rejection(outcome)).toBeInstanceOf(BadRequestException);
      },
    );

    it("accepts a UUID", async () => {
      const { outcome } = await send(succeeding("ok"), {
        headers: { "idempotency-key": "6f1c2b0e-8d3a-4f5e-9a7b-1c2d3e4f5a6b" },
      });

      expect(outcome.ok).toBe(true);
    });
  });

  describe("a new request", () => {
    it("claims the key, hands the context to the handler and echoes the key", async () => {
      const { request, response, calls, outcome } = await send(
        succeeding({ id: "tx-1" }),
      );

      expect(outcome).toEqual({ ok: true, body: { id: "tx-1" } });
      expect(calls).toHaveLength(1);
      expect(request.idempotency).toEqual(calls[0]);
      expect(response.headers["Idempotency-Key"]).toBe("key-1");
      expect(response.headers["Idempotent-Replayed"]).toBeUndefined();
    });
  });

  describe("a repeated request after success", () => {
    it("replays the stored status and body without running the handler", async () => {
      await send(succeeding({ id: "tx-1" }));

      const second = await send(mustNotRun);

      expect(second.calls).toHaveLength(0);
      expect(second.outcome).toEqual({ ok: true, body: { id: "tx-1" } });
      expect(second.response.statusCode).toBe(201);
      expect(second.response.headers["Idempotent-Replayed"]).toBe("true");
      expect(second.response.headers["Idempotency-Key"]).toBe("key-1");
    });

    it("logs the replay with the record id and without the body", async () => {
      await send(succeeding({ id: "tx-1", secret: "do-not-log" }));
      await send(mustNotRun);

      const event = logged.find((e) => e.event === "idempotency.replay");
      expect(event?.recordId).toEqual(expect.any(String));
      expect(JSON.stringify(logged)).not.toContain("do-not-log");
    });

    it("treats the same fields in another order as the same request", async () => {
      await send(succeeding({ id: "tx-1" }));

      const second = await send(mustNotRun, {
        body: { currency: "ARS", amount: "500" },
      });

      expect(second.calls).toHaveLength(0);
      expect(second.outcome.ok).toBe(true);
    });
  });

  describe("a repeated request after a deterministic failure", () => {
    it.each([
      [422, new UnprocessableEntityException("Insufficient balance")],
      [404, new NotFoundException("Wallet ARS not found")],
    ])("stores the %s and replays it as a failure", async (status, error) => {
      await send(() => {
        throw error;
      });

      const second = await send(mustNotRun);

      expect(second.calls).toHaveLength(0);
      const replayed = rejection(second.outcome) as HttpException;
      expect(replayed.getStatus()).toBe(status);
      expect(replayed.getResponse()).toEqual(error.getResponse());
      expect(second.response.headers["Idempotent-Replayed"]).toBe("true");
    });
  });

  describe("a changed request under the same key", () => {
    it("answers 422 and does not run the handler", async () => {
      await send(succeeding({ id: "tx-1" }));

      const second = await send(mustNotRun, {
        body: { amount: "900", currency: "ARS" },
      });

      expect(second.calls).toHaveLength(0);
      expect(rejection(second.outcome)).toBeInstanceOf(
        UnprocessableEntityException,
      );
      expect(events()).toContain("idempotency.mismatch");
    });

    it("answers 422 for the same body on another route", async () => {
      await send(succeeding({ id: "tx-1" }));

      const second = await send(mustNotRun, {
        route: { path: "/wallet/withdraw" },
      });

      expect(rejection(second.outcome)).toBeInstanceOf(
        UnprocessableEntityException,
      );
    });
  });

  describe("a duplicate while the first is running", () => {
    it("answers 409 with Retry-After and does not run the handler", async () => {
      let release!: () => void;
      const blocked = new Promise<void>((resolve) => (release = resolve));
      const first = send(async (ctx) => {
        await blocked;

        return succeeding({ id: "tx-1" })(ctx);
      });
      await new Promise((resolve) => setImmediate(resolve));

      const second = await send(mustNotRun);
      release();
      await first;

      expect(second.calls).toHaveLength(0);
      expect(rejection(second.outcome)).toBeInstanceOf(ConflictException);
      expect(
        Number(second.response.headers["Retry-After"]),
      ).toBeGreaterThanOrEqual(1);
      expect(second.response.headers["Idempotency-Key"]).toBe("key-1");
      expect(events()).toContain("idempotency.conflict");
    });
  });

  describe("an expired lease", () => {
    const crashedHolder = async () => {
      const claim = await store.claim({
        userId: "user-1",
        key: "key-1",
        route: ROUTE,
        requestHash: fingerprint({ method: "POST", route: ROUTE, body: BODY }),
        leaseMs: LEASE_MS,
      });
      if (!claim.claimed) throw new Error("expected a fresh claim");
      store.advance(LEASE_MS + 1);

      return claim.context;
    };

    it("is taken over: the handler runs with a new token and the old holder is fenced out", async () => {
      const stale = await crashedHolder();

      const { calls, outcome } = await send(succeeding({ id: "tx-2" }));

      expect(outcome).toEqual({ ok: true, body: { id: "tx-2" } });
      expect(calls).toHaveLength(1);
      expect(calls[0].lockToken).not.toBe(stale.lockToken);
      expect(await store.complete(stale, 201, { id: "late" })).toBe(false);
      expect(events()).toContain("idempotency.takeover");
    });

    it("answers 409 when another instance took the key over first", async () => {
      await crashedHolder();
      jest.spyOn(store, "takeOver").mockResolvedValue(null);

      const { calls, outcome } = await send(mustNotRun);

      expect(calls).toHaveLength(0);
      expect(rejection(outcome)).toBeInstanceOf(ConflictException);
    });
  });

  describe("a failure of the handler", () => {
    it("discards the claim on a 400 so a corrected request can reuse the key", async () => {
      const first = await send(() => {
        throw new BadRequestException("too many decimals");
      });
      expect(rejection(first.outcome)).toBeInstanceOf(BadRequestException);
      expect(store.records.size).toBe(0);
      expect(events()).toContain("idempotency.discard");

      const corrected = await send(succeeding({ id: "tx-1" }), {
        body: { amount: "500.5", currency: "ARS" },
      });

      expect(corrected.outcome).toEqual({ ok: true, body: { id: "tx-1" } });
    });

    it.each([
      ["a 409 from an exhausted optimistic lock", new ConflictException()],
      ["a 5xx", new InternalServerErrorException()],
      ["an error that is not an HTTP exception", new Error("boom")],
    ])(
      "releases the lease on %s so the same request can retry",
      async (_name, error) => {
        const first = await send(() => {
          throw error;
        });
        expect(rejection(first.outcome)).toBe(error);

        const retry = await send(succeeding({ id: "tx-1" }));

        expect(retry.calls).toHaveLength(1);
        expect(retry.outcome).toEqual({ ok: true, body: { id: "tx-1" } });
        expect(events()).toContain("idempotency.takeover");
      },
    );
  });

  describe("users", () => {
    it("never share a key", async () => {
      await send(succeeding({ id: "tx-a" }));

      const other = await send(succeeding({ id: "tx-b" }), {
        user: { userId: "user-2" },
      });

      expect(other.calls).toHaveLength(1);
      expect(other.outcome).toEqual({ ok: true, body: { id: "tx-b" } });
    });
  });
});
