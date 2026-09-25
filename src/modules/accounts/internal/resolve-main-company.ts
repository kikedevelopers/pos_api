import type { DataSource, EntityManager } from 'typeorm';

/**
 * Helpers de resolución de la topología multi-sucursal para el flujo de
 * "traslado al negocio principal".
 *
 * --------------------------------------------------------------------------
 * Modelo (ver `project_branches_module`)
 * --------------------------------------------------------------------------
 *
 *   - `companies.is_branch = false` → NEGOCIO PRINCIPAL (uno por owner).
 *   - `companies.is_branch = true`  → SUCURSAL.
 *   - `company_members(user_id, company_id, role)` asocia al owner con TODAS
 *     sus companies (principal + sucursales). No hay FK directa sucursal→
 *     principal en `companies` (decisión de mínimo impacto), así que la
 *     relación se reconstruye vía el owner.
 *
 * La resolución es INDEPENDIENTE del usuario logueado (puede ser un
 * empleado/manager de la sucursal, que no está en `company_members`): se
 * parte de la sucursal → se busca su owner en `company_members` → se busca
 * la company `is_branch=false` de ese owner. Así cualquier sesión válida de
 * la sucursal resuelve el mismo principal.
 */

export interface CompanyRef {
  id: number;
  name: string;
  is_branch: boolean;
}

interface CompanyRow {
  id: string;
  name: string;
  is_branch: boolean;
}

/**
 * Devuelve la referencia básica (id, name, is_branch) de una company, o
 * `null` si no existe.
 */
export async function getCompanyRef(
  runner: DataSource | EntityManager,
  companyId: number,
): Promise<CompanyRef | null> {
  const rows = await runner.query<CompanyRow[]>(
    `SELECT id::text AS id, name, is_branch FROM companies WHERE id = $1 LIMIT 1`,
    [String(companyId)],
  );
  if (rows.length === 0) {
    return null;
  }
  return { id: Number(rows[0].id), name: rows[0].name, is_branch: rows[0].is_branch === true };
}

/**
 * Resuelve el NEGOCIO PRINCIPAL asociado a una SUCURSAL.
 *
 *   1. Localiza al owner de la sucursal en `company_members`
 *      (`role = 'owner'`, `company_id = branchCompanyId`).
 *   2. Devuelve la company `is_branch = false` de ese owner.
 *
 * Devuelve `null` cuando:
 *   - la sucursal no tiene owner registrado en `company_members`, o
 *   - el owner no tiene un negocio principal (caso teórico; el registro
 *     siempre crea uno con `is_branch=false`).
 *
 * No valida que `branchCompanyId` sea efectivamente una sucursal — eso es
 * responsabilidad del caller (que ya conoce `is_branch` de la company del
 * JWT). Si se pasa el id del propio principal, el owner de esa company es él
 * mismo y devolvería su propio principal, por eso el caller debe filtrar
 * primero por `is_branch = true`.
 */
export async function resolveMainCompanyForBranch(
  runner: DataSource | EntityManager,
  branchCompanyId: number,
): Promise<CompanyRef | null> {
  const rows = await runner.query<CompanyRow[]>(
    `SELECT c.id::text AS id, c.name AS name, c.is_branch AS is_branch
     FROM company_members owner_cm
     JOIN companies c
       ON c.id = owner_cm.company_id AND c.is_branch = false
     WHERE owner_cm.user_id = (
       SELECT cm.user_id
       FROM company_members cm
       WHERE cm.company_id = $1 AND cm.role = 'owner'
       ORDER BY cm.id ASC
       LIMIT 1
     )
     ORDER BY c.id ASC
     LIMIT 1`,
    [String(branchCompanyId)],
  );
  if (rows.length === 0) {
    return null;
  }
  return { id: Number(rows[0].id), name: rows[0].name, is_branch: rows[0].is_branch === true };
}
