import "dotenv/config";
import { createHmac } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

const API_URL = process.env.API_URL || "http://localhost:3000/api/v1";
const JWT = process.env.PAYFLOW_JWT || process.env.JWT || "";
const RECEIVER_PORT = 9999;

const args = process.argv.slice(2);
const isHelp = args.includes("--help") || args.includes("-h");

if (isHelp) {
  console.log(`
Usage: PAYFLOW_JWT=<token> npx tsx scripts/webhook-demo.ts

Environment:
  PAYFLOW_JWT  (required) JWT from login cookie
  API_URL      Payflow API base URL (default: http://localhost:3000/api/v1)
`);
  process.exit(0);
}

if (!JWT) {
  console.error("❌ PAYFLOW_JWT env var required — login first:\n");
  console.error(`   TOKEN=$$(curl -s -D - -X POST ${API_URL}/auth/login \\`);
  console.error(`     -H "Content-Type: application/json" \\`);
  console.error(`     -d '{"email":"emiliano@craftbeats.dev","password":"Demo1234!"}' \\`);
  console.error(`     | grep -o 'access_token=[^;]*' | cut -d= -f2) \\`);
  console.error(`   PAYFLOW_JWT="$TOKEN" npx tsx scripts/webhook-demo.ts`);
  process.exit(1);
}

const headers = { "Content-Type": "application/json", Cookie: `access_token=${JWT}` };

// ─── Local webhook receiver ─────────────────────────────────────────

interface ReceivedWebhook {
  payload: string;
  signature: string;
}

function startReceiver(): Promise<{ url: string; waitForWebhook: () => Promise<ReceivedWebhook> }> {
  let resolveWebhook: (w: ReceivedWebhook) => void;
  const webhookPromise = new Promise<ReceivedWebhook>((resolve) => {
    resolveWebhook = resolve;
  });

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    if (req.method !== "POST") { res.writeHead(405); res.end(); return; }
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      resolveWebhook({ payload: body, signature: req.headers["x-webhook-signature"] as string });
      res.writeHead(200);
      res.end("OK");
    });
  });

  return new Promise((resolve) => {
    server.listen(RECEIVER_PORT, () => {
      console.log(`   🎧 Receiver on localhost:${RECEIVER_PORT}`);
      resolve({
        url: `http://host.docker.internal:${RECEIVER_PORT}/webhook`,
        waitForWebhook: () => webhookPromise.finally(() => server.close()),
      });
    });
  });
}

// ─── Payflow API ────────────────────────────────────────────────────

async function clearEndpoints(): Promise<void> {
  const res = await fetch(`${API_URL}/webhooks/endpoints`, { headers });
  if (!res.ok) return;
  const endpoints = (await res.json()) as Array<{ id: string }>;
  if (!endpoints.length) return;
  console.log(`\n🧹 Removing ${endpoints.length} old endpoint(s)...`);
  await Promise.all(endpoints.map((ep) => fetch(`${API_URL}/webhooks/endpoints/${ep.id}`, { method: "DELETE", headers })));
}

async function registerEndpoint(url: string): Promise<{ id: string; secret: string }> {
  const res = await fetch(`${API_URL}/webhooks/endpoints`, {
    method: "POST",
    headers,
    body: JSON.stringify({ url }),
  });
  if (!res.ok) throw new Error(`Endpoint registration failed (${res.status})`);
  return (await res.json()) as { id: string; url: string; secret: string };
}

async function triggerDeposit(): Promise<void> {
  const res = await fetch(`${API_URL}/wallet/deposit`, {
    method: "POST",
    headers,
    body: JSON.stringify({ amount: 1000, currency: "USD" }),
  });
  if (!res.ok) throw new Error(`Deposit failed (${res.status})`);
  console.log(`   ✅ Deposit: ${((await res.json()) as { id: string }).id}`);
}

type DeliveryRow = { event: string; status: string; attempts: number; responseStatus: number | null };

async function fetchDeliveries(endpointId: string): Promise<DeliveryRow[]> {
  const res = await fetch(`${API_URL}/webhooks/endpoints/${endpointId}/deliveries`, { headers });
  if (!res.ok) throw new Error(`Failed to fetch deliveries: ${res.status}`);
  return (await res.json()) as DeliveryRow[];
}

// Delivery is asynchronous: the receiver sees the request a moment before the
// relay records the result, so the row can still say "pending" right away.
async function checkDelivery(endpointId: string): Promise<void> {
  let deliveries = await fetchDeliveries(endpointId);
  for (let i = 0; i < 10 && deliveries[0]?.status === "pending"; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 300));
    deliveries = await fetchDeliveries(endpointId);
  }
  if (!deliveries.length) { console.log("   ⚠️ No deliveries"); return; }
  const d = deliveries[0];
  console.log(`   📦 ${d.event} | ${d.status} | attempts: ${d.attempts} | HTTP: ${d.responseStatus ?? "N/A"}`);
  if (d.status === "delivered") console.log("   ✅ DELIVERY CONFIRMED");
}

function hmacSignature(secret: string, payload: string): string {
  return createHmac("sha256", secret).update(payload).digest("hex");
}

// ─── Main ───────────────────────────────────────────────────────────

async function main() {
  console.log("=".repeat(55));
  console.log("  WEBHOOK DEMO");
  console.log("=".repeat(55));

  try {
    // 1. Start local receiver (Docker delivers via host.docker.internal)
    console.log("\n📡 Starting receiver...");
    const { url: receiverUrl, waitForWebhook } = await startReceiver();

    // 2. Clean stale endpoints
    await clearEndpoints();

    // 3. Register endpoint with receiver URL
    console.log("\n📍 Registering endpoint...");
    const { id, secret } = await registerEndpoint(receiverUrl);
    console.log(`   ✅ Endpoint: ${id}`);

    // 4. Trigger deposit
    console.log("\n📍 Triggering deposit...");
    await triggerDeposit();

    // 5. Wait for webhook
    console.log("\n⏳ Waiting...");
    const webhook = await waitForWebhook();

    // 6. Verify HMAC
    const expected = hmacSignature(secret, webhook.payload);
    const match = webhook.signature === expected;
    console.log("\n" + "─".repeat(55));
    console.log(`   🔐 HMAC: ${match ? "✅" : "❌"}`);
    console.log(`   📄 ${webhook.payload}`);

    // 7. Check delivery status
    await checkDelivery(id);

    // 8. Summary
    console.log("\n" + "=".repeat(55));
    console.log(match ? "  ✅ PASSED" : "  ❌ FAILED");
    console.log("=".repeat(55));
    console.log("\n   💡 webhook.site no disponible desde Docker.");
    console.log("      Para inspección visual, registrá un endpoint");

    if (!match) process.exit(1);
  } catch (err) {
    console.error(`\n❌ ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }
}

main();




/*
TOKEN=$(curl -s -D - -X POST http://localhost:3000/api/v1/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"emiliano@craftbeats.dev","password":"Demo1234!"}' \
  | grep -o 'access_token=[^;]*' | cut -d= -f2)

PAYFLOW_JWT="$TOKEN" npx tsx scripts/webhook-demo.ts
*/