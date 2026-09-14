import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, IsString, Length, Matches, MaxLength } from 'class-validator';

import { PASSWORD_MAX_LENGTH } from '../internal/password-policy';

/** Payload de `POST /auth/forgot-password`. */
export class ForgotPasswordDto {
  @ApiProperty({
    example: 'kike@esenciaygrano.com',
    description: 'Correo de la cuenta que olvidó su contraseña.',
  })
  @IsString()
  @MaxLength(254, { message: 'email no puede exceder 254 caracteres' })
  @IsEmail({}, { message: 'Escribe un correo electrónico válido' })
  email!: string;
}

/**
 * Payload de `POST /auth/reset-password`.
 *
 * El token va en el CUERPO, no en la query: las URLs quedan en logs, historial
 * y cabecera `Referer`, y este token permite tomar el control de la cuenta.
 *
 * La contraseña solo valida aquí longitud y tipo; las REGLAS (mayúscula,
 * minúscula, carácter especial) las aplica `password-policy.ts` dentro de la
 * action, para poder devolver exactamente qué falta en vez de un "inválida".
 */
export class ResetPasswordDto {
  @ApiProperty({
    example: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    description: 'Token de recuperación (64 caracteres hexadecimales).',
  })
  @IsString()
  @Length(64, 64, { message: 'token debe tener 64 caracteres' })
  @Matches(/^[0-9a-fA-F]+$/, { message: 'token debe ser hexadecimal' })
  token!: string;

  @ApiProperty({
    example: 'contrasenaSegura1!',
    minLength: 8,
    maxLength: PASSWORD_MAX_LENGTH,
    description: 'Contraseña nueva en texto plano. El servidor aplica argon2id.',
  })
  @IsString()
  @MaxLength(PASSWORD_MAX_LENGTH, {
    message: `password no puede exceder ${PASSWORD_MAX_LENGTH} caracteres`,
  })
  password!: string;
}
