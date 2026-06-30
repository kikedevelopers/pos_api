import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsArray,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

import { PERMISSION_KEYS, type PermissionKey } from '../internal/permission-catalog';

/**
 * Payload de `POST /roles`.
 *
 * Reglas:
 *   - `name`: obligatorio, no vacío. La unicidad (case/trim-insensitive) por
 *     company la garantiza el índice funcional `idx_roles_company_name_unique`;
 *     el action traduce el choque a 409.
 *   - `permissions`: array de keys del catálogo canónico. `@IsIn(..., { each })`
 *     rechaza (400) cualquier key fuera del catálogo. El action además
 *     deduplica de forma defensiva.
 *   - `color`: hex opcional (`#rgb` o `#rrggbb`).
 *   - `icon`: nombre de ícono lucide opcional.
 *
 * El cliente NO envía `company_id` ni `is_system`: el service asigna
 * `company_id` desde `req.user` e impone `is_system = false` (no se crean
 * roles de sistema vía API).
 */
export class CreateRoleDto {
  @ApiProperty({ example: 'Supervisor', maxLength: 60 })
  @IsString()
  @IsNotEmpty({ message: 'name es requerido' })
  @MinLength(1)
  @MaxLength(60)
  name!: string;

  @ApiPropertyOptional({ example: '#6366f1', description: 'Color hex (#rgb o #rrggbb).' })
  @IsOptional()
  @IsString()
  @Matches(/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/, {
    message: 'color debe ser un hex válido (#rgb o #rrggbb)',
  })
  color?: string;

  @ApiPropertyOptional({ example: 'UserCog', maxLength: 60, description: 'Ícono lucide.' })
  @IsOptional()
  @IsString()
  @MaxLength(60)
  icon?: string;

  @ApiProperty({
    example: ['canAccessPOS', 'canAccessExpenses'],
    isArray: true,
    enum: PERMISSION_KEYS,
    description:
      'Keys del catálogo canónico. Cualquier key fuera del catálogo → 400. ' +
      'Los duplicados se normalizan (deduplican) en el servidor.',
  })
  @IsArray()
  @IsIn(PERMISSION_KEYS as readonly string[], {
    each: true,
    message: 'permissions contiene una key fuera del catálogo',
  })
  permissions!: PermissionKey[];
}
