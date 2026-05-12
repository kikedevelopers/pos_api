import { PartialType, PickType } from '@nestjs/swagger';

import { CreateEmployeeDto } from './create-employee.dto';

/**
 * Payload de `PUT /employees/:id`.
 *
 * Solo cubre campos de PERFIL (name, phone, email, address, role). Las
 * credenciales (`username`, `password`) y el toggle de login viven en
 * endpoints específicos:
 *
 *   - PUT /employees/:id/credentials → `UpdateCredentialsDto`
 *   - PUT /employees/:id/toggle-login → `ToggleLoginDto`
 *
 * Razones:
 *   1. Granularidad: cambiar el nombre no debería forzar reenviar credenciales.
 *   2. Auditoría: cambios sensibles (password) deberían poder loguearse aparte.
 *   3. Espejo del contrato PlacePos (`employees.routes.ts` también separa).
 *
 * `PartialType` hace todos los campos opcionales (idempotencia: PUT con body
 * vacío no rompe). `PickType` selecciona el subconjunto permitido.
 */
export class UpdateEmployeeDto extends PartialType(
  PickType(CreateEmployeeDto, ['name', 'phone', 'email', 'address', 'role'] as const),
) {}
