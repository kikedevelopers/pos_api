import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsEmail, IsNotEmpty, IsString, MaxLength, MinLength } from 'class-validator';

/**
 * Payload de `POST /superadmin/tenants` (panel kdevs-admin).
 *
 * Espejo byte-a-byte del registro CLOUD de placepos (`POST /auth/register` /
 * `RegisterDto`): el panel crea una cuenta nueva exactamente como lo haría el
 * propio cliente al registrarse en modo cloud. La diferencia es únicamente el
 * canal de autenticación (firma Ed25519 del superadmin en vez de `@Public`) y
 * que aquí no se devuelve JWT: el owner se autentica luego desde placepos.
 *
 * Reglas idénticas a `RegisterDto` para mantener la paridad:
 *   - `name`, `lastname`: string trim, 1-100.
 *   - `company_name`: string trim, 1-255.
 *   - `email`: shape RFC + normalización a minúsculas + MaxLength 255.
 *   - `password`: 8-128 chars (la política de complejidad vive en el cliente).
 *
 * NO expone `from_offline_migration`: una cuenta creada desde el panel es un
 * registro normal (trial de 10 días), nunca una migración offline.
 */
export class CreateTenantDto {
  @ApiProperty({ example: 'Kike', maxLength: 100 })
  @IsString()
  @IsNotEmpty({ message: 'name es requerido' })
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value))
  @MinLength(1)
  @MaxLength(100)
  name!: string;

  @ApiProperty({ example: 'Pacheco', maxLength: 100 })
  @IsString()
  @IsNotEmpty({ message: 'lastname es requerido' })
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value))
  @MinLength(1)
  @MaxLength(100)
  lastname!: string;

  @ApiProperty({ example: 'kike@ares.pos', maxLength: 255 })
  @IsEmail({}, { message: 'email debe ser una dirección de correo válida' })
  @MaxLength(255)
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  )
  email!: string;

  @ApiProperty({
    example: 'contrasenaSegura1!',
    minLength: 8,
    maxLength: 128,
    description: 'Texto plano. El servidor aplica argon2id antes de persistir.',
  })
  @IsString()
  @MinLength(8, { message: 'password debe tener al menos 8 caracteres' })
  @MaxLength(128, { message: 'password no puede exceder 128 caracteres' })
  password!: string;

  @ApiProperty({ example: 'Bodegón Ares', maxLength: 255 })
  @IsString()
  @IsNotEmpty({ message: 'company_name es requerido' })
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value))
  @MinLength(1)
  @MaxLength(255)
  company_name!: string;
}
