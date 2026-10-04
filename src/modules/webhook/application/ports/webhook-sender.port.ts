import { DeliveryOutcome } from "../../domain/delivery-policy";

export interface WebhookRequest {
  readonly url: string;
  readonly secret: string;
  readonly eventId: string;
  readonly body: string;
}

export interface WebhookSender {
  /** Never throws for network or HTTP problems: they are the outcome. */
  send(request: WebhookRequest): Promise<DeliveryOutcome>;
}

export const WEBHOOK_SENDER = Symbol("WEBHOOK_SENDER");
