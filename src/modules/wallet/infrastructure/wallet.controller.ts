import { ApiCookieAuth, ApiTags } from "@nestjs/swagger";
import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  UseGuards,
} from "@nestjs/common";
import { WalletService } from "../wallet.service";
import { JwtAuthGuard } from "../../auth/guards/jwt-auth.guard";
import { KycGuard } from "../../kyc/guards/kyc.guard";
import { CurrentUser } from "../../auth/decorators/current-user.decorator";
import { Idempotent } from "../../idempotency/infrastructure/idempotent.decorator";
import { DepositDto } from "../dto/deposit.dto";
import { WithdrawDto } from "../dto/withdraw.dto";
import { ExchangeDto } from "../dto/exchange.dto";
import { SendDto } from "../dto/send.dto";

@ApiTags("Wallet")
@ApiCookieAuth()
@Controller("wallet")
@UseGuards(JwtAuthGuard)
export class WalletController {
  constructor(private readonly walletService: WalletService) {}

  @Get()
  async getWallets(@CurrentUser() user) {
    return this.walletService.getWallets(user.userId);
  }

  @Post("deposit")
  @HttpCode(HttpStatus.CREATED)
  @Idempotent()
  async deposit(@CurrentUser() user, @Body() dto: DepositDto) {
    return this.walletService.deposit({ userId: user.userId, ...dto });
  }

  @Post("withdraw")
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(KycGuard)
  @Idempotent()
  async withdraw(@CurrentUser() user, @Body() dto: WithdrawDto) {
    return this.walletService.withdraw({ userId: user.userId, ...dto });
  }

  @Post("exchange")
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(KycGuard)
  @Idempotent()
  async exchange(@CurrentUser() user, @Body() dto: ExchangeDto) {
    return this.walletService.exchange({ userId: user.userId, ...dto });
  }

  @Post("send")
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(KycGuard)
  @Idempotent()
  async send(@CurrentUser() user, @Body() dto: SendDto) {
    return this.walletService.send({ userId: user.userId, ...dto });
  }
}
