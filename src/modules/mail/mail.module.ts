import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { MailConfig } from '@/config/mail.config';

import { SendAccountActivatedEmailAction } from './actions/send-account-activated-email.action';
import { SendTestEmailAction } from './actions/send-test-email.action';
import { SendWelcomeEmailAction } from './actions/send-welcome-email.action';
import { createMailDriver } from './drivers/mail-driver.factory';
import { MAIL_DRIVER, type MailDriver } from './drivers/mail-driver.interface';
import { MailController } from './mail.controller';
import { MailService } from './mail.service';

/**
 * Módulo `mail` — el único camino por el que salen correos de pos_api.
 *
 * `@Global()` para que cualquier módulo pueda inyectar `MailService` sin
 * importar nada: enviar un correo es una capacidad transversal (recuperación de
 * contraseña, avisos de vencimiento, verificación de cuenta), y obligar a cada
 * módulo a importar `MailModule` solo añade ruido.
 *
 * El driver se resuelve UNA vez al arrancar, desde `MAIL_DRIVER` en el entorno.
 * No hay tabla ni migración: es configuración de servidor, no dato de negocio.
 */
@Global()
@Module({
  controllers: [MailController],
  providers: [
    {
      provide: MAIL_DRIVER,
      inject: [ConfigService],
      useFactory: (configService: ConfigService): MailDriver =>
        createMailDriver(configService.getOrThrow<MailConfig>('mail')),
    },
    MailService,
    SendTestEmailAction,
    SendWelcomeEmailAction,
    SendAccountActivatedEmailAction,
  ],
  // Las actions de correo se exportan porque las dispara `AuthModule` (al
  // registrar un owner y al activar su cuenta): las plantillas y sus asuntos
  // viven aquí, con el resto de los correos, no repartidos por los módulos de
  // dominio.
  exports: [MailService, SendWelcomeEmailAction, SendAccountActivatedEmailAction],
})
export class MailModule {}
