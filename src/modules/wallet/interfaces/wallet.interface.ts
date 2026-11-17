import type { IdempotencyContext } from "../../idempotency/application/ports/idempotency-store.port";
import { Currency } from "../../../shared/kernel/money";

export interface DepositInterface {
  userId: string;
  currency: Currency;
  amount: string;
  description?: string;
  idempotency?: IdempotencyContext;
}

export interface WithdrawInterface {
  userId: string;
  currency: Currency;
  amount: string;
  description?: string;
  idempotency?: IdempotencyContext;
}

export interface ExchangeInterface {
  userId: string;
  fromCurrency: Currency;
  toCurrency: Currency;
  amount: string;
  idempotency?: IdempotencyContext;
}

export interface SendInterface {
  userId: string;
  beneficiaryId: string;
  amount: string;
  idempotency?: IdempotencyContext;
}
