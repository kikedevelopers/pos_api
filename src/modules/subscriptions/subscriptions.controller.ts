import { Controller, Get, HttpStatus, NotFoundException } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

import { CurrentCompany } from '@/common/decorators/current-company.decorator';
import { Roles } from '@/common/decorators/roles.decorator';

import {
  SubscriptionResponseDto,
  toSubscriptionResponseDto,
} from './dto/subscription-response.dto';
import { SkipSubscriptionCheck } from './skip-subscription-check.decorator';
import { SubscriptionsService } from './subscriptions.service';

/**
 * Endpoint `/subscription` — consulta del estado de la suscripción de la
 * company actual.
 *
 * Roles: `owner`, `manager`, `employee` (todos los usuarios de la company
 * pueden consultar el estado).
 *
 * Multi-tenancy: `company_id` se propaga vía `@CurrentCompany()` desde el JWT.
 * Controller delgado: solo ruta y delegación al service.
 *
 * NOTA: marcado `@SkipSubscriptionCheck()` — este endpoint SÍ responde aunque la
 * suscripción esté vencida (sigue exigiendo JWT), para que el cliente pueda
 * leer y pintar su propio estado ("activa"/"vencida" + días), igual que el modo
 * offline. Todo el resto de la app sí queda bloqueado al vencer.
 */
@ApiTags('subscription')
@ApiBearerAuth('bearer')
@Controller('subscription')
export class SubscriptionsController {
  constructor(private readonly subscriptionsService: SubscriptionsService) {}

  @Get()
  @SkipSubscriptionCheck()
  @Roles('owner', 'manager', 'employee')
  @ApiOperation({ summary: 'Estado de la suscripción de la company actual.' })
  @ApiResponse({ status: HttpStatus.OK, type: SubscriptionResponseDto })
  @ApiResponse({ status: HttpStatus.NOT_FOUND, description: 'Suscripción no encontrada' })
  async getCurrent(@CurrentCompany() companyId: number): Promise<SubscriptionResponseDto> {
    const subscription = await this.subscriptionsService.findByCompany(companyId);
    if (!subscription) {
      throw new NotFoundException('Suscripción no encontrada');
    }
    return toSubscriptionResponseDto(subscription);
  }
}
