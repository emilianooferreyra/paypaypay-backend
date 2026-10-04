import { Currency } from "../../../shared/kernel/money";

export interface DepositInterface {
  userId: string;
  currency: Currency;
  amount: string;
  description?: string;
}

export interface WithdrawInterface {
  userId: string;
  currency: Currency;
  amount: string;
  description?: string;
}

export interface ExchangeInterface {
  userId: string;
  fromCurrency: Currency;
  toCurrency: Currency;
  amount: string;
}

export interface SendInterface {
  userId: string;
  beneficiaryId: string;
  amount: string;
}
