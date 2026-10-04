import { RetryPolicy } from "../../domain/delivery-policy";

export interface RelayConfig {
  readonly enabled: boolean;
  readonly pollIntervalMs: number;
  readonly batchSize: number;
  readonly leaseMs: number;
  readonly timeoutMs: number;
  readonly retry: RetryPolicy;
}

export const RELAY_CONFIG = Symbol("RELAY_CONFIG");
