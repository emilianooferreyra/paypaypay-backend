import { Currency } from "../../../../shared/kernel/money";

export interface BeneficiarySnapshot {
  readonly id: string;
  readonly alias: string;
  readonly currency: Currency;
  readonly beneficiaryType: string;
  readonly accountNumber: string;
  readonly bankName: string | null;
}

export interface BeneficiaryReader {
  findActive(
    userId: string,
    beneficiaryId: string,
  ): Promise<BeneficiarySnapshot | null>;
}

export const BENEFICIARY_READER = Symbol("BENEFICIARY_READER");
