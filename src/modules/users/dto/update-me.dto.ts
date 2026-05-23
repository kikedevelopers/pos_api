import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsEmail, IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * Payload de `PUT /users/me`. Actualización parcial del perfil del usuario
 * autenticado (siempre sobre sí mismo — el JWT define el `user_id`).
 *
 * Reglas:
 *   - `name` / `lastname`: si se envían, no pueden ser vacíos (trim previo).
 *     Si no se envían, se conservan los valores actuales.
 *   - `email`: debe ser un email válido. Es UNIQUE GLOBAL en `users` — el
 *     action atrapa la violación 23505 y la devuelve como 409 `EMAIL_TAKEN`.
 *   - Cualquier otro campo (password, type, balance, company_id) NO se
 *     acepta — `ValidationPipe` con `whitelist + forbidNonWhitelisted` los
 *     rechaza con 400.
 */
export class UpdateMeDto {
  @ApiPropertyOptional({ example: 'Kike', maxLength: 100 })
  @IsOptional()
  @IsString({ message: 'name debe ser texto' })
  @IsNotEmpty({ message: 'name no puede estar vacío' })
  @MaxLength(100)
  name?: string;

  @ApiPropertyOptional({ example: 'Pacheco', maxLength: 100 })
  @IsOptional()
  @IsString({ message: 'lastname debe ser texto' })
  @IsNotEmpty({ message: 'lastname no puede estar vacío' })
  @MaxLength(100)
  lastname?: string;

  @ApiPropertyOptional({ example: 'kike@ares.pos' })
  @IsOptional()
  @IsEmail({}, { message: 'email debe ser una dirección de correo válida' })
  @MaxLength(255)
  email?: string;
}
