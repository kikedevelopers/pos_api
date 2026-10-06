import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  Put,
  Post,
  Query,
  StreamableFile,
  UseGuards,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

import type { AppConfig } from '@/config/app.config';
import { CurrentCompany } from '@/common/decorators/current-company.decorator';
import { Public } from '@/common/decorators/public.decorator';
import { AdminLevelGuard } from '@/common/guards/admin-level.guard';

import { isEmailAlertType } from './constants';
import { UpdateEmailAlertDto } from './dto/update-email-alert.dto';
import { EmailAlertsService, type EmailAlertsSettings } from './email-alerts.service';

/**
 * `/email-alerts` — alertas por CORREO al owner (distintas de las notificaciones
 * in-app de `app-alerts`).
 *
 * Gating: NIVEL ADMIN (owner/superadmin o empleado con rol Administrador) vía
 * `AdminLevelGuard`, salvo la descarga del PDF, que es `@Public` y se autoriza
 * con el token firmado del enlace.
 */
@ApiTags('email-alerts')
@ApiBearerAuth('bearer')
@Controller('email-alerts')
export class EmailAlertsController {
  constructor(
    private readonly emailAlerts: EmailAlertsService,
    private readonly configService: ConfigService,
  ) {}

  @Get('settings')
  @UseGuards(AdminLevelGuard)
  @ApiOperation({
    summary: 'Config de alertas por correo (estado on/off) + correo del owner destino.',
  })
  @ApiResponse({ status: HttpStatus.OK })
  getSettings(@CurrentCompany() companyId: number): Promise<EmailAlertsSettings> {
    return this.emailAlerts.getSettingsFor(companyId);
  }

  @Put(':type')
  @HttpCode(HttpStatus.OK)
  @UseGuards(AdminLevelGuard)
  @ApiOperation({ summary: 'Activar/desactivar una alerta por correo.' })
  @ApiResponse({ status: HttpStatus.OK })
  async setEnabled(
    @Param('type') type: string,
    @Body() dto: UpdateEmailAlertDto,
    @CurrentCompany() companyId: number,
  ): Promise<{ type: string; enabled: boolean }> {
    if (!isEmailAlertType(type)) {
      throw new BadRequestException('Tipo de alerta por correo no soportado.');
    }
    return this.emailAlerts.setAlertEnabled(companyId, type, dto.enabled);
  }

  @Post('credit-due-today/test')
  @HttpCode(HttpStatus.OK)
  @UseGuards(AdminLevelGuard)
  @ApiOperation({
    summary: 'PRUEBA (solo dev): envía la alerta de créditos con datos mock al correo del owner.',
  })
  @ApiResponse({ status: HttpStatus.OK })
  testCreditDueToday(@CurrentCompany() companyId: number) {
    // Solo disponible fuera de producción. En prod se oculta como 404.
    const nodeEnv = this.configService.getOrThrow<AppConfig>('app').nodeEnv;
    if (nodeEnv === 'production') {
      throw new NotFoundException();
    }
    return this.emailAlerts.sendCreditDueTodayTest(companyId);
  }

  @Get('credit-due-today/pdf')
  @Public()
  @ApiOperation({
    summary:
      'Genera y descarga el PDF de créditos que vencen hoy, a partir del token firmado del enlace del correo. Público (autorizado por el token).',
  })
  @ApiResponse({ status: HttpStatus.OK })
  async downloadPdf(@Query('token') token: string): Promise<StreamableFile> {
    const { buffer, filename } = await this.emailAlerts.generateCreditsPdf(token);
    return new StreamableFile(buffer, {
      type: 'application/pdf',
      disposition: `attachment; filename="${filename}"`,
    });
  }
}
