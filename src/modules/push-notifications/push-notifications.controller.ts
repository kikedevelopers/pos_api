import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { CurrentCompany } from '@/common/decorators/current-company.decorator';
import { CurrentUser } from '@/common/decorators/current-user.decorator';
import { Roles } from '@/common/decorators/roles.decorator';
import type { AuthUser } from '@/common/types/jwt-payload.type';

import { RemovePushSubscriptionDto, SavePushSubscriptionDto } from './dto/push-subscription.dto';
import { PushNotificationsService } from './push-notifications.service';

/**
 * Endpoints `/push` — suscripción de la PWA a las notificaciones push. Cada
 * usuario solo gestiona la suscripción de su propio dispositivo; qué avisos le
 * llegan lo decide el servidor al enviar (mismo público que la campana).
 */
@ApiTags('push')
@ApiBearerAuth('bearer')
@Controller('push')
export class PushNotificationsController {
  constructor(private readonly push: PushNotificationsService) {}

  @Get('public-key')
  @Roles('owner', 'manager', 'employee')
  @ApiOperation({ summary: 'Llave pública VAPID (y si el envío está activo).' })
  publicKey(): { enabled: boolean; public_key: string | null } {
    return this.push.publicKey();
  }

  @Post('subscriptions')
  @Roles('owner', 'manager', 'employee')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Registra la suscripción push de este dispositivo.' })
  async subscribe(
    @CurrentUser() user: AuthUser,
    @CurrentCompany() companyId: number,
    @Body() dto: SavePushSubscriptionDto,
  ): Promise<void> {
    await this.push.subscribe(user, companyId, dto);
  }

  @Delete('subscriptions')
  @Roles('owner', 'manager', 'employee')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Quita la suscripción push de este dispositivo.' })
  async unsubscribe(
    @CurrentUser() user: AuthUser,
    @Body() dto: RemovePushSubscriptionDto,
  ): Promise<void> {
    await this.push.unsubscribe(user, dto.endpoint);
  }
}
