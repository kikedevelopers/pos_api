import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AlertConfigsModule } from '@/modules/alert-configs/alert-configs.module';
import { Company } from '@/modules/companies/entities/company.entity';
import { RolesModule } from '@/modules/roles/roles.module';
import { User } from '@/modules/users/entities/user.entity';

import { GenerateCreditsPdfFromTokenAction } from './actions/generate-credits-pdf-from-token.action';
import { GetCreditsDueTodayAction } from './actions/get-credits-due-today.action';
import { GetEmailAlertsSettingsAction } from './actions/get-email-alerts-settings.action';
import { SendCreditDueTodayAlertAction } from './actions/send-credit-due-today-alert.action';
import { SetEmailAlertEnabledAction } from './actions/set-email-alert-enabled.action';
import { AdminLevelGuard } from '@/common/guards/admin-level.guard';
import { EmailAlertsController } from './email-alerts.controller';
import { EmailAlertsScheduler } from './email-alerts.scheduler';
import { EmailAlertsService } from './email-alerts.service';
import { AlertPdfTokenService } from './internal/alert-pdf-token.service';

/**
 * Módulo `email-alerts` — alertas por CORREO al owner (créditos que vencen hoy,
 * y futuras). Reutiliza `MailService` (@Global), la tabla `alert_configs` para
 * el flag on/off (vía `AlertConfigsModule`), y el scheduler global de
 * `@nestjs/schedule` (el `forRoot()` lo aporta `BackupsModule`).
 *
 * `JwtModule.register({})` provee el `JwtService` que firma/verifica el token
 * del enlace de descarga del PDF (con su propio secreto por-llamada).
 */
@Module({
  imports: [
    JwtModule.register({}),
    RolesModule,
    AlertConfigsModule,
    TypeOrmModule.forFeature([User, Company]),
  ],
  controllers: [EmailAlertsController],
  providers: [
    EmailAlertsService,
    GetEmailAlertsSettingsAction,
    SetEmailAlertEnabledAction,
    SendCreditDueTodayAlertAction,
    GenerateCreditsPdfFromTokenAction,
    GetCreditsDueTodayAction,
    AlertPdfTokenService,
    AdminLevelGuard,
    EmailAlertsScheduler,
  ],
  exports: [EmailAlertsService],
})
export class EmailAlertsModule {}
