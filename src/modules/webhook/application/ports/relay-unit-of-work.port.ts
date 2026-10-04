import { DeliveryRepository } from "./delivery.repository";
import { EndpointRepository } from "./endpoint.repository";
import { OutboxEventRepository } from "./outbox-event.repository";

export interface RelayTx {
  readonly events: OutboxEventRepository;
  readonly endpoints: EndpointRepository;
  readonly deliveries: DeliveryRepository;
}

export interface RelayUnitOfWork {
  run<T>(work: (tx: RelayTx) => Promise<T>): Promise<T>;
}

export const RELAY_UNIT_OF_WORK = Symbol("RELAY_UNIT_OF_WORK");
