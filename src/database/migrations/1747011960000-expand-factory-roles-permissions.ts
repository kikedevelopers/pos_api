import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * FASE (ROLES) — expansión del catálogo de permisos y redefinición de los roles
 * de fábrica. Migración de DATOS, todas las companies. Idempotente.
 *
 * Contexto: el catálogo pasó de 18 a 22 keys. Se separaron permisos antes
 * fusionados (`canAccessCreditsReport`, `canAccessComparativeReport`,
 * `canAccessFixedExpenses`) y se añadió el de ALCANCE `canViewAllSales` (ver
 * las ventas de TODOS los cajeros vs. solo las propias). Además:
 *   - 'Cajero' se redefine a un set de 12 permisos.
 *   - Se introduce el rol de fábrica 'Vendedor' (POS + informe de Ventas, solo
 *     sus propias ventas).
 *
 * Los roles YA PERSISTIDOS en BD guardan su `permissions` como snapshot jsonb,
 * así que NO heredan los cambios del código del seed: hay que actualizarlos aquí.
 *
 * Pasos (todos idempotentes; las keys van LITERALES para que la migración sea
 * snapshot-safe e independiente de la evolución futura del catálogo):
 *
 *   1. 'Administrador' (inmutable, acceso total) → se FUERZA al set completo de
 *      22 keys. Seguro: nadie puede personalizarlo (`is_editable = false`).
 *   2. 'Cajero' → se actualiza al nuevo set de 12 SOLO si conserva EXACTAMENTE
 *      el set viejo de fábrica (5 keys). Si el owner lo personalizó, se RESPETA.
 *   3. 'Vendedor' → se inserta para cada company que aún no lo tenga.
 *
 * `down` es best-effort: elimina 'Vendedor' sin empleados asignados. NO revierte
 * los `permissions` de Administrador/Cajero (no se puede reconstruir el set
 * previo por company de forma segura) — migración de datos, down de mejor esfuerzo.
 */
export class ExpandFactoryRolesPermissions1747011960000 implements MigrationInterface {
  name = 'ExpandFactoryRolesPermissions1747011960000';

  // Set completo (22 keys) en orden canónico — Administrador.
  private static readonly ADMIN_PERMISSIONS = JSON.stringify([
    'canAccessDashboard',
    'canAccessPOS',
    'canAccessInventory',
    'canAccessPackaging',
    'canAccessCategories',
    'canAccessBanks',
    'canAccessWallets',
    'canAccessCustomers',
    'canAccessEmployees',
    'canAccessCarriers',
    'canAccessSuppliers',
    'canAccessPurchase',
    'canAccessSalesReport',
    'canAccessCreditsReport',
    'canAccessComparativeReport',
    'canAccessDailyClosureReport',
    'canAccessCashierReport',
    'canAccessClientsReport',
    'canViewAllSales',
    'canAccessExpenses',
    'canAccessFixedExpenses',
    'canAccessSettings',
  ]);

  // Nuevo set del Cajero (12 keys).
  private static readonly CASHIER_PERMISSIONS = JSON.stringify([
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
  ]);

  // Set viejo de fábrica del Cajero (5 keys) ORDENADO alfabéticamente, para
  // detectar "no personalizado" comparando contra el array de permisos ordenado.
  private static readonly OLD_CASHIER_SORTED = `ARRAY['canAccessClientsReport','canAccessCustomers','canAccessExpenses','canAccessPOS','canAccessSalesReport']::text[]`;

  private static readonly SELLER_PERMISSIONS = JSON.stringify([
    'canAccessPOS',
    'canAccessSalesReport',
  ]);

  public async up(queryRunner: QueryRunner): Promise<void> {
    const C = ExpandFactoryRolesPermissions1747011960000;

    // 1. Administrador → set completo de 22 keys (forzado; inmutable).
    await queryRunner.query(
      `UPDATE roles
       SET permissions = $1::jsonb, updated_at = now()
       WHERE is_system = true
         AND lower(btrim(name)) = 'administrador'`,
      [C.ADMIN_PERMISSIONS],
    );

    // 2. Cajero → nuevo set de 12 SOLO si conserva el set viejo exacto (no
    //    personalizado). La comparación es por CONJUNTO (orden-insensible).
    await queryRunner.query(
      `UPDATE roles
       SET permissions = $1::jsonb, updated_at = now()
       WHERE is_system = true
         AND lower(btrim(name)) = 'cajero'
         AND (
           SELECT array_agg(elem ORDER BY elem)
           FROM jsonb_array_elements_text(permissions) AS elem
         ) = ${C.OLD_CASHIER_SORTED}`,
      [C.CASHIER_PERMISSIONS],
    );

    // 3. Vendedor → insertar para cada company que aún no lo tenga.
    await queryRunner.query(
      `INSERT INTO roles (company_id, name, color, icon, permissions, is_system, is_editable)
       SELECT c.id, 'Vendedor', '#f59e0b', 'BadgeDollarSign', $1::jsonb, true, true
       FROM companies c
       WHERE NOT EXISTS (
         SELECT 1 FROM roles r
         WHERE r.company_id = c.id AND lower(btrim(r.name)) = 'vendedor'
       )`,
      [C.SELLER_PERMISSIONS],
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Best-effort: elimina 'Vendedor' de sistema sin empleados asignados. Los
    // permisos de Administrador/Cajero NO se revierten (irreversible por diseño).
    await queryRunner.query(`
      DELETE FROM roles r
      WHERE r.is_system = true
        AND lower(btrim(r.name)) = 'vendedor'
        AND NOT EXISTS (
          SELECT 1 FROM employees e WHERE e.role_id = r.id
        )
    `);
  }
}
