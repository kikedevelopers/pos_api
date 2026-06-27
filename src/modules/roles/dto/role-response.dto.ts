import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

import { isValidPermissionKey, type PermissionKey } from '../internal/permission-catalog';
import type { Role } from '../entities/role.entity';

/**
 * Fila cruda devuelta por el listado `GET /roles` (raw query con
 * `employee_count` agregado). `id` y timestamps llegan como string/Date desde
 * el driver pg; el mapper los normaliza.
 */
export interface RoleListRow {
  id: string;
  name: string;
  color: string | null;
  icon: string | null;
  permissions: PermissionKey[];
  is_system: boolean;
  is_editable: boolean;
  employee_count: number;
  created_at: Date;
  updated_at: Date;
}

/**
 * Shape de respuesta del módulo `roles`. `id` se serializa como `number`
 * (bigint en pg → cast). `employee_count` es el nº de empleados ACTIVOS con
 * ese `role_id` (0 en creación).
 */
export class RoleResponseDto {
  @ApiProperty({ example: 1 })
  id!: number;

  @ApiProperty({ example: 'Supervisor' })
  name!: string;

  @ApiPropertyOptional({ example: '#6366f1', nullable: true })
  color!: string | null;

  @ApiPropertyOptional({ example: 'UserCog', nullable: true })
  icon!: string | null;

  @ApiProperty({ example: ['canAccessPOS', 'canAccessExpenses'], isArray: true })
  permissions!: PermissionKey[];

  @ApiProperty({ example: false, description: 'Rol de fábrica no borrable.' })
  is_system!: boolean;

  @ApiProperty({
    example: true,
    description:
      'Si el rol se puede editar/eliminar. El rol de fábrica "Administrador" es ' +
      'inmutable (false); el resto es true.',
  })
  is_editable!: boolean;

  @ApiProperty({ example: 3, description: 'Empleados activos asignados a este rol.' })
  employee_count!: number;

  @ApiProperty({ example: '2026-05-12T14:30:00.000Z' })
  created_at!: string;

  @ApiProperty({ example: '2026-05-12T14:30:00.000Z' })
  updated_at!: string;
}

/**
 * Proyecta una entidad `Role` (+ su `employee_count`) al DTO público. Usado en
 * `POST` (count = 0) y `PUT` (count recalculado).
 *
 * `permissions` se filtra a keys válidas por seguridad: si una fila legacy
 * tuviera una key obsoleta, no se expone.
 */
export function roleToResponseDto(role: Role, employeeCount: number): RoleResponseDto {
  return {
    id: Number(role.id),
    name: role.name,
    color: role.color,
    icon: role.icon,
    permissions: (role.permissions ?? []).filter(isValidPermissionKey),
    is_system: role.is_system,
    is_editable: role.is_editable,
    employee_count: employeeCount,
    created_at: role.created_at.toISOString(),
    updated_at: role.updated_at.toISOString(),
  };
}

/**
 * Proyecta una fila cruda del listado (`GET /roles`) al DTO público.
 */
export function roleRowToResponseDto(row: RoleListRow): RoleResponseDto {
  return {
    id: Number(row.id),
    name: row.name,
    color: row.color,
    icon: row.icon,
    permissions: (row.permissions ?? []).filter(isValidPermissionKey),
    is_system: row.is_system,
    is_editable: row.is_editable,
    employee_count: Number(row.employee_count),
    created_at: new Date(row.created_at).toISOString(),
    updated_at: new Date(row.updated_at).toISOString(),
  };
}
