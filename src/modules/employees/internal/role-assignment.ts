/**
 * Decisiones PURAS de asignación de rol RBAC a un employee, extraídas de las
 * actions para poder testearlas sin BD. Regla de negocio única:
 *
 *   «Un rol SOLO tiene sentido cuando el empleado tiene acceso al sistema
 *    (login). Sin acceso, no hay rol. Al conceder acceso sin rol explícito, se
 *    asigna el rol por defecto 'Vendedor' (el más restringido).»
 *
 * Los ids son `string` porque `employees.role_id` es bigint en Postgres.
 */

/**
 * Rol a persistir al CREAR un employee:
 *   - `loginEnabled = false` → `null` (aunque venga un `explicitRoleId` válido).
 *   - `loginEnabled = true` + `explicitRoleId` → ese rol.
 *   - `loginEnabled = true` sin rol → `defaultRoleId` ('Vendedor'); `null` si la
 *     company no lo tiene sembrado (edge).
 */
export function resolveRoleIdOnCreate(
  loginEnabled: boolean,
  explicitRoleId: string | null,
  defaultRoleId: string | null,
): string | null {
  if (!loginEnabled) {
    return null;
  }
  return explicitRoleId !== null ? explicitRoleId : defaultRoleId;
}

/**
 * Rol a ESCRIBIR al conceder acceso (toggle-login OFF→ON). El retorno
 * `undefined` significa «no tocar el rol» (distinto de `null`, que sería
 * "asignar sin rol" — algo que aquí NUNCA hacemos).
 *
 *   - Solo asigna el `defaultRoleId` cuando se habilita el acceso Y el employee
 *     no tenía rol. Nunca pisa un rol ya asignado; deshabilitar no cambia nada.
 */
export function resolveRoleIdOnGrantAccess(
  enabled: boolean,
  currentRoleId: string | null,
  defaultRoleId: string | null,
): string | undefined {
  if (enabled && currentRoleId === null && defaultRoleId !== null) {
    return defaultRoleId;
  }
  return undefined;
}
