import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsEmail, IsNotEmpty, IsString, MaxLength } from 'class-validator';

import { AuthUserDto } from '@/modules/auth/dto/auth-response.dto';

/**
 * Payload de `POST /portal/auth/login`.
 *
 * A diferencia de `POST /auth/user` (que recibe `username` por paridad con
 * PlacePos y acepta también empleados), aquí el campo es `email` y solo entran
 * dueños: la suscripción y su cobro son del dueño de la cuenta.
 */
export class PortalLoginDto {
  @ApiProperty({ example: 'kike@ares.pos', maxLength: 255 })
  @IsEmail({}, { message: 'email debe ser una dirección de correo válida' })
  @MaxLength(255)
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  )
  email!: string;

  @ApiProperty({ example: 'contrasenaSegura1!', maxLength: 128 })
  @IsString()
  @IsNotEmpty({ message: 'password es requerido' })
  @MaxLength(128)
  password!: string;
}

/** Respuesta de `POST /portal/auth/login`. Mismo shape que el login de la app. */
export class PortalLoginResponseDto {
  @ApiProperty({
    description: 'JWT con `scope: portal`. Solo sirve en las rutas `/portal/*`.',
  })
  access_token!: string;

  @ApiProperty({ type: AuthUserDto })
  user!: AuthUserDto;
}
