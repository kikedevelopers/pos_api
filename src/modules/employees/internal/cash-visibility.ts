/**
 * Default de `can_view_cash` cuando se ASIGNA/CAMBIA el rol de un empleado.
 * Espejo PlacePos (`employeeCashVisibility.resolveCashVisibilityOnRoleChange`).
 *
 *   - Si el rol pasa a ser "Cajero" (transición: el rol nuevo es Cajero y el
 *     anterior no lo era) → true (se activa por defecto).
 *   - En cualquier otro caso → undefined (NO se toca el flag; respeta la
 *     decisión previa del admin, incluido un OFF explícito).
 *
 * Los ids son strings (bigint) igual que en el resto del backend cloud.
 */
export function resolveCashVisibilityOnRoleChange(
  newRoleId: string | null | undefined,
  previousRoleId: string | null,
  cajeroRoleId: string | null,
): boolean | undefined {
  if (cajeroRoleId == null) return undefined;
  if (newRoleId === cajeroRoleId && previousRoleId !== cajeroRoleId) return true;
  return undefined;
}
