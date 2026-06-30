import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsEmail,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

/**
 * Payload de `POST /auth/register`.
 *
 * Shape PLANO — espejo byte-a-byte de lo que el cliente Electron PlacePos
 * envía en modo CLOUD (ver `useCloudSetupForm.ts`). No hay sub-objetos
 * `user` / `company`; el servicio compone ambos en una transacción.
 *
 * Reglas de validación:
 *   - `name`, `lastname`, `company_name`: string trim, 1-100/1-255.
 *   - `email`: shape RFC + normalización a minúsculas + MaxLength 255.
 *   - `password`: 8-128 chars. NO replicamos la política exacta del cliente
 *     (mayúscula, minúscula, especial) en el servidor: el cliente puede
 *     cambiarla sin coordinación, y la política exhaustiva vive en su Zod
 *     schema. El backend solo defiende el invariante de largo / encoding.
 */
export class RegisterDto {
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

  /**
   * `true` cuando la cuenta cloud se crea DESDE un POS offline (placepos) en su
   * primera migración a "modo cloud". Marca la company con
   * `origin = 'offline_migration'` y reduce el trial a
   * `SUBSCRIPTION_MIGRATION_DAYS` (1 día) en vez de los 10 del registro normal.
   *
   * Opcional: ausente/`false` mantiene el flujo de registro normal. Es un flag
   * auto-protegido (pedir MENOS días de trial no abre superficie de abuso), por
   * eso es público y no requiere gating adicional.
   */
  @ApiPropertyOptional({
    example: false,
    description: 'true si la cuenta se crea desde la migración de un POS offline (trial de 1 día).',
  })
  @IsOptional()
  @IsBoolean()
  from_offline_migration?: boolean;
}
