import { Inject, Injectable } from "@nestjs/common";
import { DeliveryOutcome } from "../domain/delivery-policy";
import { signBody } from "../domain/webhook-signature";
import { RELAY_CONFIG } from "../application/ports/relay-config";
import type { RelayConfig } from "../application/ports/relay-config";
import type {
  WebhookRequest,
  WebhookSender,
} from "../application/ports/webhook-sender.port";

@Injectable()
export class HttpWebhookSender implements WebhookSender {
  constructor(@Inject(RELAY_CONFIG) private readonly config: RelayConfig) {}

  async send({
    url,
    secret,
    eventId,
    body,
  }: WebhookRequest): Promise<DeliveryOutcome> {
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Webhook-Signature": signBody(secret, body),
          "X-Webhook-Id": eventId,
        },
        body,
        // A redirect could lead to a host nobody registered. The status is the
        // outcome; the policy treats it as permanent.
        redirect: "manual",
        signal: AbortSignal.timeout(this.config.timeoutMs),
      });

      // Only the status matters. Dropping the body frees the connection
      // without waiting for a slow or huge response.
      await response.body?.cancel().catch(() => undefined);

      return { kind: "response", status: response.status };
    } catch (error) {
      return { kind: "failure", reason: this.describe(error) };
    }
  }

  private describe(error: unknown): string {
    if (error instanceof Error && error.name === "TimeoutError") {
      return `timeout after ${this.config.timeoutMs}ms`;
    }

    if (error instanceof Error) {
      const cause = (error as Error & { cause?: { code?: string } }).cause;
      return cause?.code ? `${error.message}: ${cause.code}` : error.message;
    }

    return String(error);
  }
}
