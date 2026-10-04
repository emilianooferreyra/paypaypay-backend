import { createServer, IncomingMessage, Server } from "node:http";
import { AddressInfo } from "node:net";
import { DEFAULT_RETRY_POLICY } from "../domain/delivery-policy";
import { signBody } from "../domain/webhook-signature";
import { RelayConfig } from "../application/ports/relay-config";
import { HttpWebhookSender } from "./http-webhook.sender";

interface Received {
  method: string | undefined;
  url: string | undefined;
  headers: IncomingMessage["headers"];
  body: string;
}

describe("HttpWebhookSender", () => {
  let server: Server;
  let baseUrl: string;
  let received: Received[];
  let respond: (
    request: IncomingMessage,
    end: (status: number, headers?: Record<string, string>) => void,
  ) => void;

  const config = (timeoutMs: number): RelayConfig => ({
    enabled: true,
    pollIntervalMs: 1000,
    batchSize: 20,
    leaseMs: 60_000,
    timeoutMs,
    retry: DEFAULT_RETRY_POLICY,
  });

  beforeAll(async () => {
    received = [];
    server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        received.push({
          method: request.method,
          url: request.url,
          headers: request.headers,
          body: Buffer.concat(chunks).toString("utf8"),
        });
        respond(request, (status, headers) => {
          response.writeHead(status, headers);
          response.end();
        });
      });
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  beforeEach(() => {
    received = [];
    respond = (_request, end) => end(200);
  });

  const send = (
    path: string,
    overrides: Partial<{ body: string; timeoutMs: number }> = {},
  ) =>
    new HttpWebhookSender(config(overrides.timeoutMs ?? 2000)).send({
      url: `${baseUrl}${path}`,
      secret: "s3cret",
      eventId: "evt-123",
      body: overrides.body ?? '{"id":"evt-123"}',
    });

  it("POSTs the exact body with its signature and the event id", async () => {
    const body = '{"id":"evt-123","event":"deposit.confirmed"}';

    await send("/hook", { body });

    expect(received).toHaveLength(1);
    expect(received[0].method).toBe("POST");
    expect(received[0].url).toBe("/hook");
    expect(received[0].body).toBe(body);
    expect(received[0].headers["content-type"]).toBe("application/json");
    expect(received[0].headers["x-webhook-id"]).toBe("evt-123");
    expect(received[0].headers["x-webhook-signature"]).toBe(
      signBody("s3cret", body),
    );
  });

  it("sends byte-identical content on a retry", async () => {
    await send("/hook");
    await send("/hook");

    expect(received[0].body).toBe(received[1].body);
    expect(received[0].headers["x-webhook-signature"]).toBe(
      received[1].headers["x-webhook-signature"],
    );
  });

  it("reports the status it received", async () => {
    for (const status of [200, 204, 404, 503]) {
      respond = (_request, end) => end(status);
      expect(await send("/hook")).toEqual({ kind: "response", status });
    }
  });

  it("does not follow a redirect: the status is the outcome", async () => {
    respond = (_request, end) => end(302, { location: `${baseUrl}/elsewhere` });

    const outcome = await send("/hook");

    expect(outcome).toEqual({ kind: "response", status: 302 });
    expect(received.map((r) => r.url)).toEqual(["/hook"]);
  });

  it("reports a failure instead of throwing when nothing is listening", async () => {
    const outcome = await new HttpWebhookSender(config(2000)).send({
      url: "http://127.0.0.1:1/hook",
      secret: "s3cret",
      eventId: "evt-123",
      body: "{}",
    });

    expect(outcome.kind).toBe("failure");
  });

  it("aborts and reports a timeout when the endpoint does not answer in time", async () => {
    respond = () => undefined; // never ends the response

    const started = Date.now();
    const outcome = await send("/slow", { timeoutMs: 150 });

    expect(outcome.kind).toBe("failure");
    expect(outcome.kind === "failure" && outcome.reason).toMatch(/timeout/i);
    expect(Date.now() - started).toBeLessThan(1500);
  });
});
