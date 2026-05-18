import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsEmail, MaxLength } from 'class-validator';

/**
 * Payload de `POST /auth/check/email`. Permite al frontend validar la
 * disponibilidad de un email ANTES de invocar `POST /auth/register`. El
 * endpoint es público (sin JWT) y cross-company por diseño: el email es
 * UNIQUE GLOBAL en `users`.
 */
export class CheckEmailDto {
  @ApiProperty({
    example: 'usuario@dominio.com',
    description: 'Email a verificar. Se normaliza a minúsculas y se valida shape RFC.',
  })
  @IsEmail({}, { message: 'email inválido' })
  @MaxLength(254, { message: 'email demasiado largo' })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  )
  email!: string;
}

/**
 * Shape de respuesta. El interceptor global envuelve el payload en
 * `{ success: true, payload: { exists } }`.
 */
export class CheckEmailResponseDto {
  @ApiProperty({ example: false })
  exists!: boolean;
}
