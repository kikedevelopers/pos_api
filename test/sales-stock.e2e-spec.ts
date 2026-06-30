import type { DataSource } from 'typeorm';

import { adjustInventory } from '@/modules/products/internal/adjust-inventory.helper';
import { APP_SETTING_KEYS } from '@/modules/app-settings/entities/app-setting.entity';

import {
  cleanupCompany,
  countRows,
  createDisposableCompany,
  E2E_TABLES,
  insertPackaging,
  insertProduct,
  tryInitDataSource,
} from './helpers/e2e-db';

/**
 * FASE 0 — Tests de CARACTERIZACIÓN del descuento de stock ACTUAL vía el helper
 * real `adjustInventory`. Red de seguridad ANTES de "compartir inventario entre
 * companies", que modificará la RESOLUCIÓN del producto (hoy filtrada por
 * company_id).
 *
 * ⚠️ AISLAMIENTO CROSS-TENANT: el assert marcado con
 *    `[[AISLAMIENTO-CROSS-TENANT — COMPARTIR CAMBIARÁ ESTO]]`
 *    codifica que HOY ajustar stock de un producto de A desde la company B
 *    lanza "El producto #X no existe en la company". Ese es el punto EXACTO que
 *    "compartir" relajará para productos compartidos.
 *
 * `adjustInventory` lockea con pessimistic_write, así que se invoca DENTRO de
 * `ds.transaction(...)`. NUNCA toca companies reales. Skip limpio si no hay BD.
 */

const COMPANY_A = '__E2E_STOCK_A__';
const COMPANY_B = '__E2E_STOCK_B__';

async function stockOf(ds: DataSource, companyId: number, productId: string): Promise<number> {
  const r = await ds.query(
    `SELECT stock::float AS stock FROM products WHERE id = $1 AND company_id = $2`,
    [productId, String(companyId)],
  );
  return parseFloat(r[0].stock);
}

async function movementsOf(ds: DataSource, companyId: number, productId: string) {
  return ds.query(
    `SELECT direction, quantity::float AS q, stock_before::float AS sb, stock_after::float AS sa, reason
     FROM inventory_movements WHERE company_id = $1 AND product_id = $2 ORDER BY created_at, id`,
    [String(companyId), productId],
  );
}

describe('Stock discount via adjustInventory (e2e, pos_db) — FASE 0 caracterización', () => {
  let ds: DataSource | null = null;
  let companyA = 0;
  let companyB = 0;

  beforeAll(async () => {
    ds = await tryInitDataSource();
    if (!ds) {
      // eslint-disable-next-line no-console
      console.warn('[e2e] pos_db no disponible — sales-stock e2e SKIPPED.');
      return;
    }
    companyA = await createDisposableCompany(ds, COMPANY_A);
    companyB = await createDisposableCompany(ds, COMPANY_B);
  });

  afterAll(async () => {
    if (!ds) {
      return;
    }
    await cleanupCompany(ds, companyA);
    await cleanupCompany(ds, companyB);
    await ds.destroy();
  });

  it('DEDUCT producto base: stock 100 - 5 = 95, registra movimiento OUT con el reason del ctx', async () => {
    if (!ds) {
      return;
    }
    const id = await insertProduct(ds, companyA, { name: 'Base DEDUCT', cost: 1, stock: 100 });

    await ds.transaction(async (manager) => {
      await adjustInventory(
        manager,
        companyA,
        [{ item_id: Number(id), quantity: 5, packaging_value: 1 }],
        'DEDUCT',
        { reason: 'SALE', referenceType: 'sale_invoice' },
      );
    });

    expect(await stockOf(ds, companyA, id)).toBe(95);
    const movs = await movementsOf(ds, companyA, id);
    expect(movs).toHaveLength(1);
    expect(movs[0].direction).toBe('OUT');
    expect(movs[0].q).toBe(5);
    expect(movs[0].sb).toBe(100);
    expect(movs[0].sa).toBe(95);
    expect(movs[0].reason).toBe('SALE');
  });

  it('RETURN producto base: suma al stock y registra movimiento IN', async () => {
    if (!ds) {
      return;
    }
    const id = await insertProduct(ds, companyA, { name: 'Base RETURN', cost: 1, stock: 10 });

    await ds.transaction(async (manager) => {
      await adjustInventory(
        manager,
        companyA,
        [{ item_id: Number(id), quantity: 3, packaging_value: 1 }],
        'RETURN',
        { reason: 'SALE_VOID', referenceType: 'sale_invoice' },
      );
    });

    expect(await stockOf(ds, companyA, id)).toBe(13);
    const movs = await movementsOf(ds, companyA, id);
    expect(movs).toHaveLength(1);
    expect(movs[0].direction).toBe('IN');
    expect(movs[0].q).toBe(3);
    expect(movs[0].sa).toBe(13);
  });

  it('DEDUCT de presentación (hijo con packaging value W): baja W del PADRE; movimiento sobre el padre', async () => {
    if (!ds) {
      return;
    }
    const W = 12;
    const parentId = await insertProduct(ds, companyA, {
      name: 'Padre Stock',
      cost: 1,
      stock: 100,
    });
    const pkgChild = await insertPackaging(ds, companyA, 'Caja x12', W);
    // Hijo: stock vive en el padre; el packaging del hijo convierte la unidad.
    const childId = await insertProduct(ds, companyA, {
      name: 'Hijo Caja',
      cost: 1,
      stock: 0,
      parentId,
      packagingId: pkgChild,
    });

    await ds.transaction(async (manager) => {
      // Sin packaging_value en la línea → el helper lee el packaging del hijo (W).
      await adjustInventory(
        manager,
        companyA,
        [{ item_id: Number(childId), quantity: 1 }],
        'DEDUCT',
        { reason: 'SALE', referenceType: 'sale_invoice' },
      );
    });

    // El delta (1 × W) se aplica al PADRE.
    expect(await stockOf(ds, companyA, parentId)).toBe(100 - W);

    // El movimiento queda registrado sobre el PADRE, no sobre el hijo.
    const movsParent = await movementsOf(ds, companyA, parentId);
    expect(movsParent).toHaveLength(1);
    expect(movsParent[0].direction).toBe('OUT');
    expect(movsParent[0].q).toBe(W);
    expect(movsParent[0].sb).toBe(100);
    expect(movsParent[0].sa).toBe(100 - W);

    const movsChild = await movementsOf(ds, companyA, childId);
    expect(movsChild).toHaveLength(0);
  });

  it('cross-tenant: ajustar stock de un producto de A desde la company B lanza "no existe en la company"', async () => {
    if (!ds) {
      return;
    }
    const idA = await insertProduct(ds, companyA, { name: 'Solo A Stock', cost: 1, stock: 50 });

    // [[AISLAMIENTO-CROSS-TENANT — COMPARTIR CAMBIARÁ ESTO]]
    // Hoy: adjustInventory filtra por company_id, así que un producto de A no
    // se resuelve desde B → lanza. ESTE es el punto que "compartir inventario"
    // relajará: para productos compartidos, B podrá descontar stock del
    // producto (físicamente en A). Cuando se implemente, este assert deberá
    // cambiar de "rechaza" a "descuenta del owner del inventario".
    await expect(
      ds.transaction(async (manager) => {
        await adjustInventory(
          manager,
          companyB,
          [{ item_id: Number(idA), quantity: 1, packaging_value: 1 }],
          'DEDUCT',
          { reason: 'SALE', referenceType: 'sale_invoice' },
        );
      }),
    ).rejects.toThrow(/no existe en la company/i);

    // El stock de A queda intacto (la transacción de B hizo rollback).
    expect(await stockOf(ds, companyA, idA)).toBe(50);
  });

  it('control estricto ON: DEDUCT que dejaría stock negativo lanza InsufficientStock (422)', async () => {
    if (!ds) {
      return;
    }
    // Activar strict_inventory_control para la company.
    await ds.query(
      `INSERT INTO app_settings (company_id, key, value) VALUES ($1, $2, 'true')
       ON CONFLICT (company_id, key) DO UPDATE SET value = 'true'`,
      [String(companyA), APP_SETTING_KEYS.STRICT_INVENTORY_CONTROL],
    );

    const id = await insertProduct(ds, companyA, { name: 'Strict Stock', cost: 1, stock: 2 });

    await expect(
      ds.transaction(async (manager) => {
        await adjustInventory(
          manager,
          companyA,
          [{ item_id: Number(id), quantity: 5, packaging_value: 1 }],
          'DEDUCT',
          { reason: 'SALE', referenceType: 'sale_invoice' },
        );
      }),
    ).rejects.toThrow(/[Ss]tock insuficiente/);

    // Rollback: stock intacto, sin movimiento.
    expect(await stockOf(ds, companyA, id)).toBe(2);
    expect(await movementsOf(ds, companyA, id)).toHaveLength(0);

    // Limpiar el setting para no afectar otros tests.
    await ds.query(`DELETE FROM app_settings WHERE company_id = $1 AND key = $2`, [
      String(companyA),
      APP_SETTING_KEYS.STRICT_INVENTORY_CONTROL,
    ]);
  });

  it('control estricto OFF (default): DEDUCT deja pasar aunque el stock quede negativo', async () => {
    if (!ds) {
      return;
    }
    // Documenta el comportamiento real: sin strict_inventory_control, el helper
    // NO bloquea ventas que dejen stock negativo (la mayoría de comercios
    // prefieren no bloquear nunca la venta).
    const id = await insertProduct(ds, companyA, { name: 'NonStrict Stock', cost: 1, stock: 2 });

    await ds.transaction(async (manager) => {
      await adjustInventory(
        manager,
        companyA,
        [{ item_id: Number(id), quantity: 5, packaging_value: 1 }],
        'DEDUCT',
        { reason: 'SALE', referenceType: 'sale_invoice' },
      );
    });

    expect(await stockOf(ds, companyA, id)).toBe(-3);
    const movs = await movementsOf(ds, companyA, id);
    expect(movs).toHaveLength(1);
    expect(movs[0].sa).toBe(-3);
  });

  it('cleanup deja ambas companies sin rastro', async () => {
    if (!ds) {
      return;
    }
    await cleanupCompany(ds, companyA);
    await cleanupCompany(ds, companyB);
    for (const table of E2E_TABLES) {
      expect(await countRows(ds, table, companyA)).toBe(0);
      expect(await countRows(ds, table, companyB)).toBe(0);
    }
    companyA = await createDisposableCompany(ds, COMPANY_A);
    companyB = await createDisposableCompany(ds, COMPANY_B);
  });
});
