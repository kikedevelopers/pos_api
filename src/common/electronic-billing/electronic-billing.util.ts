import { ForbiddenException } from '@nestjs/common';

/**
 * Código de error estable para el front: la Facturación Electrónica está apagada
 * para el negocio. El cliente lo usa para refrescar el perfil y ocultar la UI de
 * FE cuando su estado local quedó rancio (SPA: el superadmin pudo desactivarla
 * sin que el usuario recargue).
 */
export const ELECTRONIC_BILLING_DISABLED = 'ELECTRONIC_BILLING_DISABLED';

/**
 * Algo capaz de ejecutar SQL crudo: un `DataSource`, un `EntityManager` (dentro
 * de una transacción) o un `Repository`. Todos exponen `.query(...)`, así que el
 * mismo chequeo sirve en un guard (con DataSource) y dentro de una action (con
 * el manager de la transacción — lectura consistente con la escritura).
 */
export interface Queryable {
  query<T = unknown>(sql: string, params?: unknown[]): Promise<T>;
}

/**
 * Lee el estado ACTUAL de la Facturación Electrónica del negocio desde la BD (no
 * del JWT ni del front). Es la fuente de verdad: si el superadmin la desactivó
 * hace 10s, aquí ya sale `false` aunque la sesión del usuario siga creyendo que
 * es facturador.
 */
export async function isElectronicBillingEnabled(
  db: Queryable,
  companyId: number | string,
): Promise<boolean> {
  const rows = await db.query<Array<{ electronic_billing_enabled: boolean }>>(
    `SELECT electronic_billing_enabled FROM companies WHERE id = $1`,
    [String(companyId)],
  );
  return rows[0]?.electronic_billing_enabled === true;
}

/**
 * Exige que la FE esté activa para el negocio; si no, corta con 403 y el código
 * estable `ELECTRONIC_BILLING_DISABLED`. Se llama en TODA operación de FE
 * (asignar IVA a un producto, leer el catálogo de tarifas…) para que el backend
 * mande sobre el estado del front.
 */
export async function assertElectronicBillingEnabled(
  db: Queryable,
  companyId: number | string,
): Promise<void> {
  if (!(await isElectronicBillingEnabled(db, companyId))) {
    throw new ForbiddenException({
      code: ELECTRONIC_BILLING_DISABLED,
      message: 'La Facturación Electrónica no está habilitada para este negocio.',
    });
  }
}
