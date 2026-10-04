import { randomUUID } from "node:crypto";
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
} from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { CreateEndpointDto } from "./dto/create-endpoint.dto";
import { PrismaService } from "../prisma/prisma.service";

@ApiTags("Webhooks")
@Controller("webhooks")
export class WebhookController {
  constructor(private readonly prisma: PrismaService) {}

  @Post("endpoints")
  @HttpCode(HttpStatus.CREATED)
  async createEndpoint(@Body() dto: CreateEndpointDto) {
    const secret = randomUUID();
    const endpoint = await this.prisma.webhookEndpoint.create({
      data: {
        url: dto.url,
        secret,
      },
    });

    return {
      id: endpoint.id,
      url: endpoint.url,
      secret: endpoint.secret,
    };
  }

  @Get("endpoints")
  async listEndpoints() {
    return this.prisma.webhookEndpoint.findMany({
      select: { id: true, url: true, active: true, createdAt: true },
    });
  }

  @Delete("endpoints/:id")
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteEndpoint(@Param("id") id: string) {
    await this.prisma.webhookEndpoint.delete({ where: { id } });
  }

  @Get("endpoints/:id/deliveries")
  async listDeliveries(@Param("id") id: string) {
    return this.prisma.webhookDelivery.findMany({
      where: { endpointId: id },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        event: true,
        status: true,
        attempts: true,
        responseStatus: true,
        createdAt: true,
      },
    });
  }
}
