import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean } from 'class-validator';

/**
 * Payload de `PATCH /superadmin/tenants/:companyId/activation`.
 *
 * Interruptor de activación MANUAL del owner que dispara el operador desde el
 * panel: `true` da la cuenta por activada sin pasar por el correo; `false` la
 * revierte a "sin activar", lo que vuelve a BLOQUEAR el inicio de sesión del
 * dueño (`ACCOUNT_NOT_ACTIVATED`).
 */
export class UpdateActivationDto {
  @ApiProperty({
    example: true,
    description:
      'true activa la cuenta manualmente; false la revierte a "sin activar" (bloquea el login).',
  })
  @IsBoolean()
  active!: boolean;
}
