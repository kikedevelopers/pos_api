import type { EntityManager } from 'typeorm';

import { PERMISSION_KEYS, type PermissionKey } from './permission-catalog';

/**
 * Definición declarativa de un rol de fábrica (`is_system = true`).
 */
export interface SystemRoleSeed {
  /** Nombre canónico (también la llave de idempotencia, normalizado). */
  name: string;
  /** Ícono lucide de presentación. */
  icon: string;
  /** Color hex de presentación. */
  color: string;
  /** Permisos del catálogo que el rol concede. */
  permissions: readonly PermissionKey[];
  /**
   * ¿El owner puede editarlo/eliminarlo? El 'Administrador' es INMUTABLE
   * (`is_editable = false`, acceso total inamovible); el 'Cajero' SÍ es
   * editable. Persistido en `roles.is_editable`.
   */
  isEditable: boolean;
}

/**
 * Los 3 roles de fábrica que toda company nueva recibe. Mantener en paridad
 * con placepos. El orden es estable (Administrador primero) por prolijidad,
 * pero el seed es idempotente por nombre, no por orden.
 *
 *   - Administrador → TODAS las 22 keys (derivadas de `PERMISSION_KEYS` para
 *     que el set crezca solo si el catálogo crece). INMUTABLE
 *     (`is_editable = false`): no se puede editar ni eliminar, ni siquiera el
 *     owner — concede siempre acceso total.
 *   - Cajero        → catálogos, clientes, compras, informes (ventas/cartera/
 *     finanzas/clientes), gastos variables y POS. Ve las ventas de TODOS los
 *     cajeros (`canViewAllSales`). EDITABLE.
 *   - Vendedor      → SOLO POS e informe de Ventas, y únicamente SUS propias
 *     ventas (sin `canViewAllSales`). El rol más restringido. EDITABLE.
 */
export const SYSTEM_ROLE_SEEDS: readonly SystemRoleSeed[] = [
  {
    name: 'Administrador',
    icon: 'ShieldCheck',
    color: '#6366f1',
    permissions: [...PERMISSION_KEYS],
    isEditable: false,
  },
  {
    name: 'Cajero',
    icon: 'Receipt',
    color: '#10b981',
    permissions: [
      'canAccessPOS',
      'canAccessInventory',
      'canAccessPackaging',
      'canAccessCategories',
      'canAccessCustomers',
      'canAccessPurchase',
      'canAccessSalesReport',
      'canAccessCreditsReport',
      'canAccessDailyClosureReport',
      'canAccessClientsReport',
      'canAccessExpenses',
      'canViewAllSales',
    ],
    isEditable: true,
  },
  {
    name: 'Vendedor',
    icon: 'BadgeDollarSign',
    color: '#f59e0b',
    permissions: ['canAccessPOS', 'canAccessSalesReport'],
    isEditable: true,
  },
];

/**
 * Nombre canónico del rol de fábrica que se asigna POR DEFECTO a todo empleado
 * al que se le concede acceso al sistema (login) sin un rol explícito. Es el
 * rol más restringido ('Vendedor': SOLO POS + informe de SUS ventas). La regla
 * de negocio: un rol solo tiene sentido cuando el empleado puede entrar a la
 * app; sin acceso, `role_id` queda en null.
 */
export const DEFAULT_SYSTEM_ACCESS_ROLE_NAME = 'Vendedor';

/** Normaliza un nombre de rol para la comparación de idempotencia. */
function normalizeRoleName(name: string): string {
  return name.trim().toLowerCase();
}

/**
 * Resuelve el `id` de un rol de una company por su nombre normalizado
 * (`lower(btrim(name))`). Devuelve `null` si la company aún no tiene ese rol
 * (edge case: seeds no corridos). Se usa para asignar el rol por defecto
 * ('Vendedor') al conceder acceso al sistema a un empleado.
 *
 * SQL crudo a propósito (igual que `seedSystemRolesForCompany`): snapshot-safe
 * y compatible con el `EntityManager` de una transacción.
 */
export async function findRoleIdByName(
  manager: EntityManager,
  companyId: number | string,
  name: string,
): Promise<string | null> {
  const rows: Array<{ id: string }> = await manager.query(
    `SELECT id FROM roles WHERE company_id = $1 AND lower(btrim(name)) = $2 LIMIT 1`,
    [String(companyId), normalizeRoleName(name)],
  );
  return rows.length > 0 ? String(rows[0].id) : null;
}

/**
 * Siembra (de forma IDEMPOTENTE) los 3 roles de fábrica (`is_system = true`)
 * de una company.
 *
 * Reutilizable en dos contextos:
 *   1. `RegisterAction` — dentro de la transacción que crea Company + User, de
 *      modo que cada company nazca con sus roles (rollback total si algo falla).
 *   2. Migración de back-fill — recorre las companies existentes que aún no los
 *      tengan.
 *
 * Implementado con SQL crudo (`manager.query`) a propósito: NO acopla la
 * migración de back-fill a la metadata de la entidad `Role` (snapshot-safe) y
 * funciona igual con el `EntityManager` de la transacción del register o con el
 * `queryRunner.manager` de una migración.
 *
 * Idempotencia: lee los nombres ya presentes (normalizados con `lower(btrim)`)
 * y sólo inserta los faltantes. Correrlo N veces no duplica. El índice único
 * funcional `idx_roles_company_name_unique` es la red de seguridad final.
 *
 * @param manager   EntityManager (de una transacción) o queryRunner.manager.
 * @param companyId Id de la company (bigint; acepta number o string).
 */
export async function seedSystemRolesForCompany(
  manager: EntityManager,
  companyId: number | string,
): Promise<void> {
  const cid = String(companyId);

  const existing: Array<{ norm: string }> = await manager.query(
    `SELECT lower(btrim(name)) AS norm FROM roles WHERE company_id = $1`,
    [cid],
  );
  const present = new Set<string>(existing.map((row) => row.norm));

  for (const seed of SYSTEM_ROLE_SEEDS) {
    const norm = normalizeRoleName(seed.name);
    if (present.has(norm)) {
      continue;
    }

    await manager.query(
      `INSERT INTO roles (company_id, name, color, icon, permissions, is_system, is_editable)
       VALUES ($1, $2, $3, $4, $5::jsonb, true, $6)`,
      [cid, seed.name, seed.color, seed.icon, JSON.stringify(seed.permissions), seed.isEditable],
    );
    present.add(norm);
  }
}
