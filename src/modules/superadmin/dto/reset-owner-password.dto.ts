import { ApiProperty } from '@nestjs/swagger';
import { IsString, MaxLength, MinLength } from 'class-validator';

/**
 * Payload de `PATCH /superadmin/tenants/:companyId/owner/password`.
 *
 * Reseteo de contraseña por el OPERADOR del panel (superadmin), no por el
 * propio owner: por eso NO pide `current_password` como hace placepos
 * (`PUT /users/me/password`) — el operador no la conoce. Solo fija una nueva
 * contraseña (8-128 chars; el server aplica argon2id). La política de
 * complejidad exhaustiva vive en el formulario del panel.
 */
export class ResetOwnerPasswordDto {
  @ApiProperty({
    minLength: 8,
    maxLength: 128,
    description: 'Nueva contraseña en texto plano. El servidor aplica argon2id antes de persistir.',
  })
  @IsString()
  @MinLength(8, { message: 'password debe tener al menos 8 caracteres' })
  @MaxLength(128, { message: 'password no puede exceder 128 caracteres' })
  password!: string;
}
