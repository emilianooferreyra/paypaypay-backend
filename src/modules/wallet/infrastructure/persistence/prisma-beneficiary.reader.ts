import { Injectable } from "@nestjs/common";
import { PrismaService } from "../../../prisma/prisma.service";
import {
  BeneficiaryReader,
  BeneficiarySnapshot,
} from "../../application/ports/beneficiary.reader";

@Injectable()
export class PrismaBeneficiaryReader implements BeneficiaryReader {
  constructor(private readonly prisma: PrismaService) {}

  async findActive(
    userId: string,
    beneficiaryId: string,
  ): Promise<BeneficiarySnapshot | null> {
    const row = await this.prisma.beneficiary.findFirst({
      where: { id: beneficiaryId, userId, isActive: true },
    });

    if (row === null) return null;

    return {
      id: row.id,
      alias: row.alias,
      currency: row.currency,
      beneficiaryType: row.beneficiaryType,
      accountNumber: row.accountNumber,
      bankName: row.bankName,
    };
  }
}
