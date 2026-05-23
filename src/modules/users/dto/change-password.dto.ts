import { ApiProperty } from '@nestjs/swagger';
import { IsString, MaxLength, MinLength } from 'class-validator';

/**
 * Payload de `PUT /users/me/password`.
 *
 * Reglas:
 *   - `current_password` requerido: el action lo verifica con
 *     `argon2.verify(stored, current_password)` antes de aceptar el cambio.
 *     Si no coincide → 401.
 *   - `new_password`: mínimo 8 caracteres (paridad con el `RegisterDto`).
 *   - `confirm_password`: el controller/action valida que coincida con
 *     `new_password`; si no, 400. Mantiene el guard del frontend en el
 *     servidor.
 */
export class ChangePasswordDto {
  @ApiProperty({ example: 'OldPass123!', minLength: 1, maxLength: 200 })
  @IsString({ message: 'current_password debe ser texto' })
  @MinLength(1, { message: 'current_password es obligatorio' })
  @MaxLength(200)
  current_password!: string;

  @ApiProperty({ example: 'NewPass456!', minLength: 8, maxLength: 200 })
  @IsString({ message: 'new_password debe ser texto' })
  @MinLength(8, { message: 'new_password debe tener al menos 8 caracteres' })
  @MaxLength(200)
  new_password!: string;

  @ApiProperty({ example: 'NewPass456!', minLength: 8, maxLength: 200 })
  @IsString({ message: 'confirm_password debe ser texto' })
  @MinLength(8, { message: 'confirm_password debe tener al menos 8 caracteres' })
  @MaxLength(200)
  confirm_password!: string;
}
