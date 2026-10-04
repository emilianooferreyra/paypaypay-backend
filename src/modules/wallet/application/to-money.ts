import { BadRequestException } from "@nestjs/common";
import {
  AmountTooLargeError,
  Currency,
  InvalidAmountError,
  Money,
  PrecisionError,
} from "../../../shared/kernel/money";

/**
 * Turns a client-supplied amount into Money, answering with the same 400 the
 * API gave before `Money` existed. Domain errors stay domain errors below this
 * line; only this boundary decides they are HTTP errors.
 */
export function toMoney(rawAmount: string, currency: Currency): Money {
  try {
    return Money.of(rawAmount, currency);
  } catch (error) {
    if (error instanceof PrecisionError) {
      throw new BadRequestException(
        `${error.currency} supports at most ${error.maxDecimals} decimal places`,
      );
    }
    if (error instanceof AmountTooLargeError) {
      throw new BadRequestException(
        `amount must be less than ${error.ceiling}`,
      );
    }
    if (error instanceof InvalidAmountError) {
      throw new BadRequestException(error.message);
    }
    throw error;
  }
}
