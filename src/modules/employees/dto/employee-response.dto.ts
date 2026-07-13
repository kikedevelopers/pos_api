import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

import { Employee, EmployeeRole } from '@/modules/employees/entities/employee.entity';

import type { EmployeeWithCashSummary } from '../actions/find-all-employees.action';
import type { EmployeeWithCashRegister } from '../actions/find-employee-by-id.action';

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

  @ApiPropertyOptional({
    example: 5,
    nullable: true,
    description:
      'FASE 2 (ROLES) — Id del rol PERSONALIZADO de acceso a módulos. NULL = sin rol (permisos legacy).',
  })
  role_id!: number | null;

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

  @ApiProperty({
    example: false,
    description:
      'Permiso del empleado para ver márgenes y ganancias. Default false; solo un admin lo cambia.',
  })
  can_view_profit!: boolean;

  @ApiProperty({
    example: false,
    description:
      'Permiso del empleado para ver el saldo y el historial de caja en el POS. Default false; se activa con el rol Cajero.',
  })
  can_view_cash!: boolean;

  @ApiProperty({
    example: false,
    description:
      'Subpermiso: ver el margen (%) del producto en el configurador del POS. El toggle principal cascada su valor.',
  })
  can_view_product_margin!: boolean;

  @ApiProperty({
    example: false,
    description:
      'Subpermiso: ver la ganancia ($) del producto en el configurador del POS. El toggle principal cascada su valor.',
  })
  can_view_product_profit!: boolean;

  @ApiPropertyOptional({
    example: 'Kike Pacheco',
    nullable: true,
    description: 'Snapshot del full_name del owner que creó al employee.',
  })
  created_by!: string | null;

  @ApiProperty({ example: '2026-05-12T14:30:00.000Z' })
  created_at!: string;

  @ApiPropertyOptional({
    example: '2026-07-13T14:28:00.000Z',
    nullable: true,
    description:
      'Fecha/hora (ISO) del último inicio de sesión exitoso del empleado. NULL = nunca se ha conectado.',
  })
  last_login!: string | null;

  @ApiPropertyOptional({
    example: 42,
    nullable: true,
    description:
      'ID del `User` espejo (paridad PlacePos). NULL hasta que el employee se materializa (toggle-login ON o creación con login).',
  })
  user_id!: number | null;

  @ApiProperty({
    example: 75000,
    description:
      'Balance corriente de la caja PERMANENTE del empleado. 0 si no tiene caja (login no habilitado).',
  })
  cash_balance!: number;

  @ApiProperty({
    example: 50000,
    description:
      'Fondo fijo (`base_amount`) de la caja PERMANENTE del empleado. 0 si no tiene caja.',
  })
  base_amount!: number;
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
/**
 * Mapper base de `Employee` → respuesta SIN datos de caja (uso interno).
 *
 * Los endpoints que devuelven el listado o el detalle deben usar el mapper
 * con caja, NO este. `cash_balance` y `base_amount` son obligatorios en el
 * contrato PlacePos: omitirlos rompe paridad.
 */
function toEmployeeBaseResponse(
  employee: Employee,
): Omit<EmployeeResponseDto, 'cash_balance' | 'base_amount' | 'user_id'> {
  return {
    id: Number(employee.id),
    name: employee.name,
    phone: employee.phone,
    email: employee.email,
    address: employee.address,
    role: employee.role,
    role_id: employee.role_id !== null ? Number(employee.role_id) : null,
    login_enabled: employee.login_enabled,
    username: employee.username,
    has_credentials: Boolean(employee.username),
    is_archived: employee.is_archived,
    can_view_profit: employee.can_view_profit,
    can_view_cash: employee.can_view_cash,
    can_view_product_margin: employee.can_view_product_margin,
    can_view_product_profit: employee.can_view_product_profit,
    created_by: employee.created_by,
    created_at: employee.created_at.toISOString(),
    last_login: employee.last_login ? employee.last_login.toISOString() : null,
  };
}

/**
 * Mapper del listado `GET /employees`. Espejo PlacePos: cada item incluye
 * `cash_balance`, `base_amount` y `user_id` (resueltos en bulk para evitar
 * N+1 — ver `FindAllEmployeesAction`).
 */
export function toEmployeeResponseDto(result: EmployeeWithCashSummary): EmployeeResponseDto {
  return {
    ...toEmployeeBaseResponse(result.employee),
    user_id: result.employee.user_id !== null ? Number(result.employee.user_id) : null,
    cash_balance: result.cash_balance,
    base_amount: result.base_amount,
  };
}

/**
 * Shape de `GET /employees/:id` — alias del response del listado para
 * mantener tipado explícito en el controller. Mismo shape que
 * `EmployeeResponseDto`.
 */
export class EmployeeDetailResponseDto extends EmployeeResponseDto {}

export function toEmployeeDetailResponseDto(
  result: EmployeeWithCashRegister,
): EmployeeDetailResponseDto {
  return {
    ...toEmployeeBaseResponse(result.employee),
    user_id: result.employee.user_id !== null ? Number(result.employee.user_id) : null,
    cash_balance: result.cash_balance,
    base_amount: result.base_amount,
  };
}

/**
 * Mapper para endpoints de mutación (`POST`/`PUT`) que devuelven un
 * `Employee` sin re-leer la caja (el action no la consulta). En esos
 * endpoints el frontend ya tiene el cash_balance del último `GET` y no se
 * espera que cambie por la mutación de perfil.
 *
 * PlacePos en sus endpoints POST/PUT también re-consulta la caja y devuelve
 * `cash_balance`/`base_amount`. Para mantener paridad sin obligar al action
 * a hacer una query extra, resolvemos a 0/0 cuando el employee no tiene
 * `user_id` (caso común en creación/edición de perfil). Para mutaciones
 * sobre employees con user_id, el cliente puede refrescar con GET /:id.
 */
export function toEmployeeResponseDtoFromEntity(employee: Employee): EmployeeResponseDto {
  return {
    ...toEmployeeBaseResponse(employee),
    user_id: employee.user_id !== null ? Number(employee.user_id) : null,
    cash_balance: 0,
    base_amount: 0,
  };
}
