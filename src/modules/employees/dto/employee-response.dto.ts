import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

import { Employee, EmployeeRole } from '@/modules/employees/entities/employee.entity';

/**
 * Shape de respuesta del módulo employees. Espejo byte-a-byte del payload
 * que sirve `employees.routes.ts` en PlacePos, con los siguientes detalles:
 *
 *   - `id` se serializa como `number`. PG entrega bigint como string; el
 *     mapper hace el cast. Si en el futuro se superan los ~9e15 employees,
 *     habrá que cambiar a string en respuesta — log de warning queda como
 *     evidencia.
 *
 *   - `password` NUNCA se expone. Esta es la razón principal por la que NO
 *     usamos la entidad cruda como response: el `Employee` carga la columna
 *     `password` por defecto y un error en serialización podría filtrarla.
 *
 *   - `has_credentials` es derivado: `!!username`. Espeja PlacePos
 *     byte-por-byte — solo mira presencia del username, no el estado de
 *     `login_enabled`. Para saber si el employee puede autenticarse, el
 *     cliente debe usar `login_enabled` directamente.
 *
 *   - `created_at` se serializa como ISO 8601 (string), no `Date`. Coincide
 *     con PlacePos y con cualquier otro endpoint del API.
 */
export class EmployeeResponseDto {
  @ApiProperty({ example: 1 })
  id!: number;

  @ApiProperty({ example: 'Juan Pérez' })
  name!: string;

  @ApiPropertyOptional({ example: '+58 412 1234567', nullable: true })
  phone!: string | null;

  @ApiPropertyOptional({ example: 'juan@bodegonares.com', nullable: true })
  email!: string | null;

  @ApiPropertyOptional({ example: 'Av. Principal #123, Caracas', nullable: true })
  address!: string | null;

  @ApiProperty({ example: EmployeeRole.EMPLOYEE, enum: EmployeeRole })
  role!: EmployeeRole;

  @ApiProperty({ example: false })
  login_enabled!: boolean;

  @ApiPropertyOptional({ example: 'kike-bodegonares', nullable: true })
  username!: string | null;

  @ApiProperty({
    example: false,
    description:
      'Derivado: `!!username` (espeja PlacePos). Para saber si el employee puede autenticarse, usa `login_enabled` directamente.',
  })
  has_credentials!: boolean;

  @ApiProperty({ example: false })
  is_archived!: boolean;

  @ApiPropertyOptional({
    example: 'Kike Pacheco',
    nullable: true,
    description: 'Snapshot del full_name del owner que creó al employee.',
  })
  created_by!: string | null;

  @ApiProperty({ example: '2026-05-12T14:30:00.000Z' })
  created_at!: string;
}

/**
 * Convierte una entidad `Employee` (con potencialmente `password` cargado en
 * memoria) al DTO público. **Único punto** donde la entidad cruda se proyecta
 * a respuesta — si alguien expone `Employee` directamente, es un bug.
 *
 * `id` y casting: `Employee.id` es `string` (bigint en pg). Lo casteamos a
 * number con `Number(...)`. No usamos el helper `bigintToNumber` de
 * `auth.service.ts` para no inyectar un logger en una función pura; en
 * práctica los ids de employees no se aproximan a `MAX_SAFE_INTEGER`.
 */
export function toEmployeeResponseDto(employee: Employee): EmployeeResponseDto {
  return {
    id: Number(employee.id),
    name: employee.name,
    phone: employee.phone,
    email: employee.email,
    address: employee.address,
    role: employee.role,
    login_enabled: employee.login_enabled,
    username: employee.username,
    has_credentials: Boolean(employee.username),
    is_archived: employee.is_archived,
    created_by: employee.created_by,
    created_at: employee.created_at.toISOString(),
  };
}
