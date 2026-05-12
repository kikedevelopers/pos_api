import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsEmail,
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
  ValidateIf,
} from 'class-validator';

import { EmployeeRole } from '@/modules/employees/entities/employee.entity';

/**
 * Payload de `POST /employees`.
 *
 * Reglas cruzadas:
 *   - Si `login_enabled === true` → `username` y `password` son OBLIGATORIOS
 *     y se validan con `@ValidateIf`. La invariante también está enforced en
 *     DB por `chk_employees_login_requires_credentials`; el service la
 *     re-verifica antes de hashear para devolver un 400 amigable en vez de
 *     un 500 desde la capa de Postgres.
 *
 *   - Si `login_enabled === false` → `username`/`password` se aceptan como
 *     ausentes (el `ValidationPipe` global está con `whitelist: true,
 *     forbidNonWhitelisted: true`; el controller debe enviar shapes válidas).
 *
 * El cliente NO envía `company_id` ni `created_by`/`created_by_id`: el service
 * los resuelve desde `req.user` (multi-tenant: nunca confiar en el payload).
 */
export class CreateEmployeeDto {
  @ApiProperty({ example: 'Juan Pérez', maxLength: 100 })
  @IsString()
  @IsNotEmpty()
  @MinLength(1)
  @MaxLength(100)
  name!: string;

  @ApiPropertyOptional({ example: '+58 412 1234567', maxLength: 30, nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(30)
  phone?: string;

  @ApiPropertyOptional({ example: 'juan@bodegonares.com', maxLength: 255, nullable: true })
  @IsOptional()
  @IsEmail({}, { message: 'email debe ser una dirección de correo válida' })
  @MaxLength(255)
  email?: string;

  @ApiPropertyOptional({ example: 'Av. Principal #123, Caracas', maxLength: 500, nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  address?: string;

  @ApiProperty({
    example: EmployeeRole.EMPLOYEE,
    enum: EmployeeRole,
    description: 'Rol operativo del empleado dentro de la company.',
  })
  @IsEnum(EmployeeRole, { message: 'role debe ser uno de: manager, employee' })
  role!: EmployeeRole;

  @ApiProperty({
    example: false,
    description: 'Si es `true`, `username` y `password` son obligatorios.',
  })
  @IsBoolean()
  login_enabled!: boolean;

  @ApiPropertyOptional({
    example: 'kike-bodegonares',
    minLength: 3,
    maxLength: 60,
    description:
      'Identificador de login UNIQUE GLOBAL (no per-company). Requerido si `login_enabled === true`.',
  })
  // Solo validar tipo/longitud cuando login_enabled === true. Si es false y se
  // envía un username, el `ValidationPipe` lo strippea por `whitelist`. La
  // regla cruzada queda explícita aquí y como red de seguridad en el service.
  @ValidateIf((o: CreateEmployeeDto) => o.login_enabled === true)
  @IsString()
  @IsNotEmpty({ message: 'username es requerido cuando login_enabled = true' })
  @MinLength(3)
  @MaxLength(60)
  username?: string;

  @ApiPropertyOptional({
    example: 'contrasenaSegura1!',
    minLength: 8,
    maxLength: 128,
    description: 'Texto plano. El servidor aplica argon2id. Requerido si `login_enabled === true`.',
  })
  @ValidateIf((o: CreateEmployeeDto) => o.login_enabled === true)
  @IsString()
  @IsNotEmpty({ message: 'password es requerido cuando login_enabled = true' })
  @MinLength(8, { message: 'password debe tener al menos 8 caracteres' })
  @MaxLength(128, { message: 'password no puede exceder 128 caracteres' })
  password?: string;
}
