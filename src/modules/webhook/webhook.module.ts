import { Module } from "@nestjs/common";
import { envs } from "../../config";
import { PrismaModule } from "../prisma/prisma.module";
import { DeliverDueWebhooks } from "./application/deliver-due-webhooks";
import { CLOCK, RANDOM } from "./application/ports/clock.port";
import { DELIVERY_QUEUE } from "./application/ports/delivery-queue.token";
import { RELAY_CONFIG } from "./application/ports/relay-config";
import { RELAY_UNIT_OF_WORK } from "./application/ports/relay-unit-of-work.port";
import { WEBHOOK_SENDER } from "./application/ports/webhook-sender.port";
import { RelayOutboxEvents } from "./application/relay-outbox-events";
import { HttpWebhookSender } from "./infrastructure/http-webhook.sender";
import { OutboxRelayRunner } from "./infrastructure/outbox-relay.runner";
import { PrismaDeliveryQueue } from "./infrastructure/persistence/prisma-delivery.queue";
import { PrismaRelayUnitOfWork } from "./infrastructure/persistence/prisma-relay-unit-of-work";
import { buildRelayConfig } from "./infrastructure/relay-config.factory";
import { SystemClock } from "./infrastructure/system-clock";
import { WebhookController } from "./webhook.controller";

@Module({
  imports: [PrismaModule],
  controllers: [WebhookController],
  providers: [
    RelayOutboxEvents,
    DeliverDueWebhooks,
    OutboxRelayRunner,
    PrismaRelayUnitOfWork,
    PrismaDeliveryQueue,
    HttpWebhookSender,
    SystemClock,
    // Ports bound to their adapters. Swapping how events are delivered (an
    // SQS publisher, say) means changing these lines, not the use cases.
    { provide: RELAY_UNIT_OF_WORK, useExisting: PrismaRelayUnitOfWork },
    { provide: DELIVERY_QUEUE, useExisting: PrismaDeliveryQueue },
    { provide: WEBHOOK_SENDER, useExisting: HttpWebhookSender },
    { provide: CLOCK, useExisting: SystemClock },
    { provide: RANDOM, useValue: Math.random },
    // Validated here, at startup: a lease shorter than the request timeout
    // would let two workers deliver the same webhook.
    { provide: RELAY_CONFIG, useFactory: () => buildRelayConfig(envs) },
  ],
  exports: [OutboxRelayRunner],
})
export class WebhookModule {}
