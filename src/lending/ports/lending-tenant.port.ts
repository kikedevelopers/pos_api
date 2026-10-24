/** Token de inyección del puerto de tenant. */
export const LENDING_TENANT = Symbol('LENDING_TENANT');

/**
 * La company vista desde préstamos: solo importa si opera como prestamista.
 * El tipo de negocio lo administra el panel superadmin (fuera de préstamos).
 */
export interface LendingTenantPort {
  isLender(companyId: number): Promise<boolean>;
}
