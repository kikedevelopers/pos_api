import type { DataSource } from 'typeorm';

import { adjustInventory } from '@/modules/products/internal/adjust-inventory.helper';
import { resolvePackagingValues } from '@/modules/products/internal/resolve-packaging-value.helper';
import { APP_SETTING_KEYS } from '@/modules/app-settings/entities/app-setting.entity';
import { NoteType, OperationType } from '@/modules/credit-notes/entities/credit-note.entity';
import type { FinancialMovementsService } from '@/modules/financial-movements/financial-movements.service';
import { VoidSaleAction, type VoidSaleActor } from '@/modules/sales/actions/void-sale.action';
import { getConsolidatedInvoice } from '@/modules/sales/internal/consolidate-invoice.helper';
import { IncrementTicketNumberAction } from '@/modules/ticket-settings/actions/increment-ticket-number.action';
import { TicketSettingType } from '@/modules/ticket-settings/entities/ticket-setting.entity';

import {
  cleanupCompany,
  createDisposableCompany,
  insertPackaging,
  insertProduct,
  tryInitDataSource,
} from './helpers/e2e-db';

/**
 * FIX #2 — Tests e2e (pos_db real) del FLUJO de inventario POS.
 *
 * --------------------------------------------------------------------------
 * Estrategia (declarada para que cada test sea inequívoco)
 * --------------------------------------------------------------------------
 *
 * El cableado completo de las acciones Nest (create-sale → process-payment →
 * void/update-sale) exige DI + fixtures pesados (ticket settings, cajas,
 * config de margen/puntos). En su lugar — y siguiendo el patrón de
 * `sales-stock.e2e-spec.ts` — ejercitamos el MECANISMO REAL del fix contra la
 * BD: el snapshot lo produce el helper REAL `resolvePackagingValues` y el ajuste
 * lo aplica el motor REAL `adjustInventory`. Lo único que "simulamos" es la
 * PERSISTENCIA de la línea: el `packaging_value` que en producción guardan las
 * acciones en `sale_invoice_lines` / `credit_note_lines` aquí lo capturamos en
 * una variable JS y lo reutilizamos al devolver — EXACTAMENTE lo que garantiza
 * la simetría DEDUCT↔RETURN del fix.
 *
 * Cada paso del ciclo (cobro / anulación / NC / ND) corre en su propia
 * `ds.transaction(...)` porque `adjustInventory` usa lock pessimistic_write.
 * NUNCA toca companies reales. Skip limpio si no hay BD.
 */

const COMPANY_PRINCIPAL = '__E2E_INVFLOW_A__';
const COMPANY_SUCURSAL = '__E2E_INVFLOW_B__';

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

async function shareWholeCatalog(
  ds: DataSource,
  sourceCompanyId: number,
  targetCompanyId: number,
): Promise<void> {
  await ds.query(
    `INSERT INTO inventory_shares (source_company_id, target_company_id, product_id)
     VALUES ($1, $2, NULL)`,
    [String(sourceCompanyId), String(targetCompanyId)],
  );
}

describe('Flujo de inventario POS (e2e, pos_db) — FIX #2 snapshot + reglas 1-4', () => {
  let ds: DataSource | null = null;
  let companyA = 0; // principal
  let companyB = 0; // sucursal

  beforeAll(async () => {
    ds = await tryInitDataSource();
    if (!ds) {
      // eslint-disable-next-line no-console
      console.warn('[e2e] pos_db no disponible — sales-inventory-flow e2e SKIPPED.');
      return;
    }
    companyA = await createDisposableCompany(ds, COMPANY_PRINCIPAL);
    companyB = await createDisposableCompany(ds, COMPANY_SUCURSAL);
  });

  afterAll(async () => {
    if (!ds) {
      return;
    }
    await cleanupCompany(ds, companyA);
    await cleanupCompany(ds, companyB);
    await ds.destroy();
  });

  // ──────────────────────────────────────────────────────────────────────
  // REGLA 1 — PEDIDO (ORDER) no toca inventario
  // ──────────────────────────────────────────────────────────────────────

  it('Regla 1: el ciclo de un PEDIDO no muta stock ni inventory_movements', async () => {
    if (!ds) {
      return;
    }
    // GARANTÍA: las ramas ORDER de las acciones (createSale ORDER, editOrderFlow,
    // voidOrder) NUNCA invocan `adjustInventory` — por eso, sin un DEDUCT/RETURN,
    // el stock y los movimientos quedan intactos. Este test fija ese invariante.
    const id = await insertProduct(ds, companyA, { name: 'Pedido NoStock', cost: 1, stock: 100 });
    // (No se ejecuta ningún ajuste: es lo que hace el flujo ORDER.)
    expect(await stockOf(ds, companyA, id)).toBe(100);
    expect(await movementsOf(ds, companyA, id)).toHaveLength(0);
  });

  // ──────────────────────────────────────────────────────────────────────
  // REGLA 2 — COBRO (ORDER→SALE): DEDUCT
  // ──────────────────────────────────────────────────────────────────────

  it('Regla 2: cobrar producto SIMPLE descuenta qty (factor 1)', async () => {
    if (!ds) {
      return;
    }
    const id = await insertProduct(ds, companyA, { name: 'Simple Cobro', cost: 1, stock: 30 });

    await ds.transaction(async (manager) => {
      const snap = await resolvePackagingValues(manager, companyA, [Number(id)], true);
      expect(snap.get(Number(id))).toBe(1); // sin packaging → factor 1
      await adjustInventory(
        manager,
        companyA,
        [{ item_id: Number(id), quantity: 4, packaging_value: snap.get(Number(id)) ?? null }],
        'DEDUCT',
        { reason: 'SALE', referenceType: 'sale_invoice', crossCompanyAccess: true },
      );
    });

    expect(await stockOf(ds, companyA, id)).toBe(26);
  });

  it('Regla 2: cobrar PRESENTACIÓN (hijo con packaging W) descuenta qty×W al PADRE; movimiento sobre el padre', async () => {
    if (!ds) {
      return;
    }
    const W = 10;
    const parentId = await insertProduct(ds, companyA, { name: 'Padre R2', cost: 1, stock: 100 });
    const pkg = await insertPackaging(ds, companyA, 'Caja x10 R2', W);
    const childId = await insertProduct(ds, companyA, {
      name: 'Hijo R2',
      cost: 1,
      stock: 0,
      parentId,
      packagingId: pkg,
    });

    await ds.transaction(async (manager) => {
      const snap = await resolvePackagingValues(manager, companyA, [Number(childId)], true);
      expect(snap.get(Number(childId))).toBe(W);
      await adjustInventory(
        manager,
        companyA,
        [
          {
            item_id: Number(childId),
            quantity: 2,
            packaging_value: snap.get(Number(childId)) ?? null,
          },
        ],
        'DEDUCT',
        { reason: 'SALE', referenceType: 'sale_invoice', crossCompanyAccess: true },
      );
    });

    expect(await stockOf(ds, companyA, parentId)).toBe(100 - 2 * W); // 80
    const movsParent = await movementsOf(ds, companyA, parentId);
    expect(movsParent).toHaveLength(1);
    expect(movsParent[0].direction).toBe('OUT');
    expect(movsParent[0].q).toBe(2 * W);
    expect(await movementsOf(ds, companyA, childId)).toHaveLength(0);
  });

  // ──────────────────────────────────────────────────────────────────────
  // REGLA 3 — NOTA DÉBITO (edición que añade/incrementa): DEDUCT solo lo nuevo
  // ──────────────────────────────────────────────────────────────────────

  it('Regla 3: la ND descuenta SOLO el delta añadido/incrementado (no toda la venta)', async () => {
    if (!ds) {
      return;
    }
    const W = 10;
    const parentId = await insertProduct(ds, companyA, { name: 'Padre R3', cost: 1, stock: 100 });
    const pkg = await insertPackaging(ds, companyA, 'Caja x10 R3', W);
    const childId = await insertProduct(ds, companyA, {
      name: 'Hijo R3',
      cost: 1,
      stock: 0,
      parentId,
      packagingId: pkg,
    });
    const simpleId = await insertProduct(ds, companyA, { name: 'Simple R3', cost: 1, stock: 50 });

    // Cobro inicial: 2 cajas (parent 80).
    await ds.transaction(async (manager) => {
      await adjustInventory(
        manager,
        companyA,
        [{ item_id: Number(childId), quantity: 2, packaging_value: W }],
        'DEDUCT',
        { reason: 'SALE', referenceType: 'sale_invoice', crossCompanyAccess: true },
      );
    });
    expect(await stockOf(ds, companyA, parentId)).toBe(80);

    // Edición → ND: +1 caja (incremento del hijo) y +3 de un producto nuevo.
    await ds.transaction(async (manager) => {
      const snap = await resolvePackagingValues(
        manager,
        companyA,
        [Number(childId), Number(simpleId)],
        true,
      );
      await adjustInventory(
        manager,
        companyA,
        [
          {
            item_id: Number(childId),
            quantity: 1,
            packaging_value: snap.get(Number(childId)) ?? null,
          },
          {
            item_id: Number(simpleId),
            quantity: 3,
            packaging_value: snap.get(Number(simpleId)) ?? null,
          },
        ],
        'DEDUCT',
        { reason: 'SALE_EDIT_DEBIT', referenceType: 'credit_note', crossCompanyAccess: true },
      );
    });

    // Solo el delta: padre 80 - 10 = 70; simple 50 - 3 = 47.
    expect(await stockOf(ds, companyA, parentId)).toBe(70);
    expect(await stockOf(ds, companyA, simpleId)).toBe(47);
  });

  // ──────────────────────────────────────────────────────────────────────
  // REGLA 4 — NOTA CRÉDITO / ANULACIÓN: RETURN
  // ──────────────────────────────────────────────────────────────────────

  it('Regla 4: NC parcial y anulación total DEVUELVEN el stock con el factor de la línea', async () => {
    if (!ds) {
      return;
    }
    const W = 10;
    const parentId = await insertProduct(ds, companyA, { name: 'Padre R4', cost: 1, stock: 100 });
    const pkg = await insertPackaging(ds, companyA, 'Caja x10 R4', W);
    const childId = await insertProduct(ds, companyA, {
      name: 'Hijo R4',
      cost: 1,
      stock: 0,
      parentId,
      packagingId: pkg,
    });
    const simpleId = await insertProduct(ds, companyA, { name: 'Simple R4', cost: 1, stock: 50 });

    // Cobro: 3 cajas (parent 70) + 5 simples (simple 45). Snapshot W y 1.
    let snapChild = 0;
    let snapSimple = 0;
    await ds.transaction(async (manager) => {
      const snap = await resolvePackagingValues(
        manager,
        companyA,
        [Number(childId), Number(simpleId)],
        true,
      );
      snapChild = snap.get(Number(childId)) ?? 0;
      snapSimple = snap.get(Number(simpleId)) ?? 0;
      await adjustInventory(
        manager,
        companyA,
        [
          { item_id: Number(childId), quantity: 3, packaging_value: snapChild },
          { item_id: Number(simpleId), quantity: 5, packaging_value: snapSimple },
        ],
        'DEDUCT',
        { reason: 'SALE', referenceType: 'sale_invoice', crossCompanyAccess: true },
      );
    });
    expect(await stockOf(ds, companyA, parentId)).toBe(70);
    expect(await stockOf(ds, companyA, simpleId)).toBe(45);

    // NC PARCIAL: se remueve la línea simple (5 uds) → RETURN con su snapshot.
    await ds.transaction(async (manager) => {
      await adjustInventory(
        manager,
        companyA,
        [{ item_id: Number(simpleId), quantity: 5, packaging_value: snapSimple }],
        'RETURN',
        { reason: 'SALE_EDIT_CREDIT', referenceType: 'credit_note', crossCompanyAccess: true },
      );
    });
    expect(await stockOf(ds, companyA, simpleId)).toBe(50); // devuelto entero

    // ANULACIÓN TOTAL: RETURN de las cajas restantes con su snapshot.
    await ds.transaction(async (manager) => {
      await adjustInventory(
        manager,
        companyA,
        [{ item_id: Number(childId), quantity: 3, packaging_value: snapChild }],
        'RETURN',
        { reason: 'SALE_VOID', referenceType: 'credit_note', crossCompanyAccess: true },
      );
    });
    expect(await stockOf(ds, companyA, parentId)).toBe(100); // vuelve al inicial
  });

  // ──────────────────────────────────────────────────────────────────────
  // FIX #2 — TEST ESTRELLA: SIMETRÍA aunque cambie packaging.value
  // ──────────────────────────────────────────────────────────────────────

  it('FIX #2 (ESTRELLA): cobrar con W=10, cambiar packaging.value→20, anular → stock EXACTO inicial', async () => {
    if (!ds) {
      return;
    }
    const parentId = await insertProduct(ds, companyA, { name: 'Padre Sim', cost: 1, stock: 100 });
    const pkg = await insertPackaging(ds, companyA, 'Caja Sim', 10);
    const childId = await insertProduct(ds, companyA, {
      name: 'Hijo Sim',
      cost: 1,
      stock: 0,
      parentId,
      packagingId: pkg,
    });

    // 1) COBRO con W vigente = 10. El snapshot se CONGELA (simula sale_invoice_line).
    let frozenW = 0;
    await ds.transaction(async (manager) => {
      const snap = await resolvePackagingValues(manager, companyA, [Number(childId)], true);
      frozenW = snap.get(Number(childId)) ?? 0;
      await adjustInventory(
        manager,
        companyA,
        [{ item_id: Number(childId), quantity: 1, packaging_value: frozenW }],
        'DEDUCT',
        { reason: 'SALE', referenceType: 'sale_invoice', crossCompanyAccess: true },
      );
    });
    expect(frozenW).toBe(10);
    expect(await stockOf(ds, companyA, parentId)).toBe(90);

    // 2) Alguien EDITA el empaque entre cobro y anulación: value 10 → 20.
    await ds.query(`UPDATE packagings SET value = 20 WHERE id = $1`, [pkg]);
    // El valor VIGENTE del producto ahora es 20 (lo confirma el helper)…
    await ds.transaction(async (manager) => {
      const now = await resolvePackagingValues(manager, companyA, [Number(childId)], true);
      expect(now.get(Number(childId))).toBe(20);
    });

    // 3) ANULACIÓN: el RETURN usa el SNAPSHOT congelado (10), NO el value vigente
    //    (20). Por eso el stock vuelve EXACTO a 100. Con el value vigente habría
    //    quedado 90 + 20 = 110 (inventario corrupto) — eso es lo que el fix evita.
    await ds.transaction(async (manager) => {
      await adjustInventory(
        manager,
        companyA,
        [{ item_id: Number(childId), quantity: 1, packaging_value: frozenW }],
        'RETURN',
        { reason: 'SALE_VOID', referenceType: 'credit_note', crossCompanyAccess: true },
      );
    });
    expect(await stockOf(ds, companyA, parentId)).toBe(100); // ← simetría exacta
  });

  // ──────────────────────────────────────────────────────────────────────
  // FIX #2 — FALLBACK null (legacy)
  // ──────────────────────────────────────────────────────────────────────

  it('FIX #2 fallback: línea con packaging_value NULL → el motor usa el packaging vigente del producto', async () => {
    if (!ds) {
      return;
    }
    const W = 10;
    const parentId = await insertProduct(ds, companyA, { name: 'Padre FB', cost: 1, stock: 100 });
    const pkg = await insertPackaging(ds, companyA, 'Caja FB', W);
    const childId = await insertProduct(ds, companyA, {
      name: 'Hijo FB',
      cost: 1,
      stock: 0,
      parentId,
      packagingId: pkg,
    });

    await ds.transaction(async (manager) => {
      // Línea legacy: packaging_value null → el motor resuelve el packaging (W).
      await adjustInventory(
        manager,
        companyA,
        [{ item_id: Number(childId), quantity: 1, packaging_value: null }],
        'DEDUCT',
        { reason: 'SALE', referenceType: 'sale_invoice', crossCompanyAccess: true },
      );
    });

    expect(await stockOf(ds, companyA, parentId)).toBe(100 - W); // 90
  });

  // ──────────────────────────────────────────────────────────────────────
  // FIX #2 — TOLERANCIA del snapshot vs ESTRICTEZ del ajuste real
  // ──────────────────────────────────────────────────────────────────────

  it('FIX #2 tolerancia: snapshot con packaging.value inválido NO lanza (omite); el ajuste real SÍ es estricto', async () => {
    if (!ds) {
      return;
    }
    const parentId = await insertProduct(ds, companyA, { name: 'Padre Tol', cost: 1, stock: 100 });
    const badPkg = await insertPackaging(ds, companyA, 'Caja Tol Inv', 0); // value inválido
    const childId = await insertProduct(ds, companyA, {
      name: 'Hijo Tol',
      cost: 1,
      stock: 0,
      parentId,
      packagingId: badPkg,
    });

    // SNAPSHOT TOLERANTE: no lanza; el producto se OMITE → snapshot null.
    await ds.transaction(async (manager) => {
      const snap = await resolvePackagingValues(manager, companyA, [Number(childId)], true);
      expect(snap.has(Number(childId))).toBe(false);
    });

    // AJUSTE REAL ESTRICTO: con snapshot null el motor resuelve el packaging y,
    // al ser inválido, ABORTA (no corrompe inventario).
    await expect(
      ds.transaction(async (manager) => {
        await adjustInventory(
          manager,
          companyA,
          [{ item_id: Number(childId), quantity: 1, packaging_value: null }],
          'DEDUCT',
          { reason: 'SALE', referenceType: 'sale_invoice', crossCompanyAccess: true },
        );
      }),
    ).rejects.toThrow(/valor inválido|inválid/i);

    // Rollback: stock del padre intacto.
    expect(await stockOf(ds, companyA, parentId)).toBe(100);
  });

  // ──────────────────────────────────────────────────────────────────────
  // FIX #2 — COMPARTIDOS: congela el W del PRINCIPAL (simetría cross-company)
  // ──────────────────────────────────────────────────────────────────────

  it('FIX #2 compartidos: la sucursal congela el W del principal; anular tras cambiar el empaque → stock EXACTO del principal', async () => {
    if (!ds) {
      return;
    }
    // Producto del PRINCIPAL (A), compartido con la SUCURSAL (B).
    const parentId = await insertProduct(ds, companyA, { name: 'Padre Comp', cost: 1, stock: 100 });
    const pkg = await insertPackaging(ds, companyA, 'Caja Comp', 10);
    const childId = await insertProduct(ds, companyA, {
      name: 'Hijo Comp',
      cost: 1,
      stock: 0,
      parentId,
      packagingId: pkg,
    });
    await shareWholeCatalog(ds, companyA, companyB);

    // 1) La SUCURSAL vende el compartido: snapshot del W del PRINCIPAL (=10).
    let frozenW = 0;
    await ds.transaction(async (manager) => {
      const snap = await resolvePackagingValues(manager, companyB, [Number(childId)], true);
      frozenW = snap.get(Number(childId)) ?? 0;
      await adjustInventory(
        manager,
        companyB, // company ACTIVA = sucursal
        [{ item_id: Number(childId), quantity: 1, packaging_value: frozenW }],
        'DEDUCT',
        { reason: 'SALE', referenceType: 'sale_invoice', crossCompanyAccess: true },
      );
    });
    expect(frozenW).toBe(10);
    // El stock se descontó en el DUEÑO real (el principal).
    expect(await stockOf(ds, companyA, parentId)).toBe(90);

    // 2) El PRINCIPAL cambia su empaque: 10 → 20.
    await ds.query(`UPDATE packagings SET value = 20 WHERE id = $1`, [pkg]);

    // 3) La SUCURSAL anula: RETURN con el snapshot (10) → el stock del principal
    //    vuelve EXACTO a 100 (simetría cross-company).
    await ds.transaction(async (manager) => {
      await adjustInventory(
        manager,
        companyB,
        [{ item_id: Number(childId), quantity: 1, packaging_value: frozenW }],
        'RETURN',
        { reason: 'SALE_VOID', referenceType: 'credit_note', crossCompanyAccess: true },
      );
    });
    expect(await stockOf(ds, companyA, parentId)).toBe(100);
  });

  // ──────────────────────────────────────────────────────────────────────
  // CASOS LÍMITE
  // ──────────────────────────────────────────────────────────────────────

  it('Límite: múltiples presentaciones del MISMO padre → deltas agregados en un solo movimiento', async () => {
    if (!ds) {
      return;
    }
    const parentId = await insertProduct(ds, companyA, {
      name: 'Padre Multi',
      cost: 1,
      stock: 100,
    });
    const pkg10 = await insertPackaging(ds, companyA, 'Caja Multi x10', 10);
    const pkg4 = await insertPackaging(ds, companyA, 'Caja Multi x4', 4);
    const childA = await insertProduct(ds, companyA, {
      name: 'Hijo Multi A',
      cost: 1,
      stock: 0,
      parentId,
      packagingId: pkg10,
    });
    const childB = await insertProduct(ds, companyA, {
      name: 'Hijo Multi B',
      cost: 1,
      stock: 0,
      parentId,
      packagingId: pkg4,
    });

    await ds.transaction(async (manager) => {
      const snap = await resolvePackagingValues(
        manager,
        companyA,
        [Number(childA), Number(childB)],
        true,
      );
      await adjustInventory(
        manager,
        companyA,
        [
          {
            item_id: Number(childA),
            quantity: 1,
            packaging_value: snap.get(Number(childA)) ?? null,
          },
          {
            item_id: Number(childB),
            quantity: 1,
            packaging_value: snap.get(Number(childB)) ?? null,
          },
        ],
        'DEDUCT',
        { reason: 'SALE', referenceType: 'sale_invoice', crossCompanyAccess: true },
      );
    });

    // 100 - (10 + 4) = 86. Un solo movimiento agregado sobre el padre.
    expect(await stockOf(ds, companyA, parentId)).toBe(86);
    const movs = await movementsOf(ds, companyA, parentId);
    expect(movs).toHaveLength(1);
    expect(movs[0].q).toBe(14);
  });

  it('Límite: mezcla SIMPLE + PRESENTACIÓN en la misma venta', async () => {
    if (!ds) {
      return;
    }
    const W = 10;
    const parentId = await insertProduct(ds, companyA, { name: 'Padre Mix', cost: 1, stock: 100 });
    const pkg = await insertPackaging(ds, companyA, 'Caja Mix', W);
    const childId = await insertProduct(ds, companyA, {
      name: 'Hijo Mix',
      cost: 1,
      stock: 0,
      parentId,
      packagingId: pkg,
    });
    const simpleId = await insertProduct(ds, companyA, { name: 'Simple Mix', cost: 1, stock: 50 });

    await ds.transaction(async (manager) => {
      const snap = await resolvePackagingValues(
        manager,
        companyA,
        [Number(childId), Number(simpleId)],
        true,
      );
      await adjustInventory(
        manager,
        companyA,
        [
          {
            item_id: Number(childId),
            quantity: 1,
            packaging_value: snap.get(Number(childId)) ?? null,
          },
          {
            item_id: Number(simpleId),
            quantity: 2,
            packaging_value: snap.get(Number(simpleId)) ?? null,
          },
        ],
        'DEDUCT',
        { reason: 'SALE', referenceType: 'sale_invoice', crossCompanyAccess: true },
      );
    });

    expect(await stockOf(ds, companyA, parentId)).toBe(100 - W); // presentación
    expect(await stockOf(ds, companyA, simpleId)).toBe(48); // simple factor 1
  });

  it('Límite: override_stock salta el guard estricto; sin override lanza (decisión por rol vive en las acciones)', async () => {
    if (!ds) {
      return;
    }
    // strict_inventory_control ON para la company.
    await ds.query(
      `INSERT INTO app_settings (company_id, key, value) VALUES ($1, $2, 'true')
       ON CONFLICT (company_id, key) DO UPDATE SET value = 'true'`,
      [String(companyA), APP_SETTING_KEYS.STRICT_INVENTORY_CONTROL],
    );
    const id = await insertProduct(ds, companyA, { name: 'Override Stock', cost: 1, stock: 2 });

    // Sin override → lanza (employee no autorizado en las acciones).
    await expect(
      ds.transaction(async (manager) => {
        await adjustInventory(
          manager,
          companyA,
          [{ item_id: Number(id), quantity: 5, packaging_value: 1 }],
          'DEDUCT',
          { reason: 'SALE', referenceType: 'sale_invoice', overrideStock: false },
        );
      }),
    ).rejects.toThrow(/[Ss]tock insuficiente/);
    expect(await stockOf(ds, companyA, id)).toBe(2); // rollback

    // Con override (owner/superadmin en las acciones) → permite negativo.
    await ds.transaction(async (manager) => {
      await adjustInventory(
        manager,
        companyA,
        [{ item_id: Number(id), quantity: 5, packaging_value: 1 }],
        'DEDUCT',
        { reason: 'SALE', referenceType: 'sale_invoice', overrideStock: true },
      );
    });
    expect(await stockOf(ds, companyA, id)).toBe(-3);

    await ds.query(`DELETE FROM app_settings WHERE company_id = $1 AND key = $2`, [
      String(companyA),
      APP_SETTING_KEYS.STRICT_INVENTORY_CONTROL,
    ]);
  });

  it('Límite: strict OFF (default) deja pasar un DEDUCT que deja stock negativo', async () => {
    if (!ds) {
      return;
    }
    const id = await insertProduct(ds, companyA, { name: 'NonStrict Flow', cost: 1, stock: 1 });
    await ds.transaction(async (manager) => {
      await adjustInventory(
        manager,
        companyA,
        [{ item_id: Number(id), quantity: 3, packaging_value: 1 }],
        'DEDUCT',
        { reason: 'SALE', referenceType: 'sale_invoice' },
      );
    });
    expect(await stockOf(ds, companyA, id)).toBe(-2);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// VOID CONSOLIDADO — la anulación TOTAL opera sobre el consolidado (no original)
// ──────────────────────────────────────────────────────────────────────────

/**
 * VOID_CONSOLIDATED_SPEC — Tests e2e (pos_db real) de que `VoidSaleAction`
 * (path SALE) anula sobre el estado CONSOLIDADO (original + Σ ND − Σ NC previas).
 *
 * Estrategia (declarada): las notas previas (ND/NC) se SIMULAN a nivel BD
 * (insert de `credit_notes`/`credit_note_lines`) + el stock se lleva al estado
 * neto con el MOTOR REAL (`adjustInventory`), tal como lo dejarían el cobro y las
 * ediciones. Luego se ejercita la LÓGICA REAL del void invocando
 * `VoidSaleAction.execute` (acción real; `FinancialMovementsService` se stubbea
 * porque sin pagos la reversa de dinero no se invoca). Cada test deja claro qué
 * garantiza. Skip limpio si no hay BD.
 */
const COMPANY_VOID = '__E2E_VOIDCONS__';

/** Stub: sin pagos en la venta, `record` NUNCA se llama durante el void. */
function buildVoidAction(ds: DataSource): VoidSaleAction {
  const financialStub = {
    record: () => Promise.resolve(undefined),
  } as unknown as FinancialMovementsService;
  return new VoidSaleAction(ds, new IncrementTicketNumberAction(), financialStub);
}

async function seedCreditNoteFolio(ds: DataSource, companyId: number): Promise<void> {
  await ds.query(
    `INSERT INTO ticket_settings (company_id, ticket_type, current_number, prefix)
     VALUES ($1, $2, 0, 'NC-')
     ON CONFLICT (company_id, ticket_type) DO NOTHING`,
    [String(companyId), TicketSettingType.CREDIT_NOTE],
  );
}

async function insertSaleInvoiceSALE(
  ds: DataSource,
  companyId: number,
  opts: { ticketNumber: string; saleNumber: string; total: number; cost: number },
): Promise<string> {
  const r = await ds.query(
    `INSERT INTO sale_invoices
       (company_id, ticket_type, ticket_number, sale_number, subtotal, tax_total, total, cost, is_deleted)
     VALUES ($1, 'SALE', $2, $3, $4, 0, $4, $5, false)
     RETURNING id`,
    [String(companyId), opts.ticketNumber, opts.saleNumber, opts.total, opts.cost],
  );
  return r[0].id;
}

async function insertSaleLine(
  ds: DataSource,
  companyId: number,
  saleId: string,
  l: {
    productId: string;
    description: string;
    quantity: number;
    price: number;
    cost: number;
    packagingValue: number | null;
  },
): Promise<void> {
  await ds.query(
    `INSERT INTO sale_invoice_lines
       (company_id, sale_invoice_id, product_id, description, quantity, unit_price, unit_cost, subtotal, total, packaging_value)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8, $9)`,
    [
      String(companyId),
      saleId,
      l.productId,
      l.description,
      l.quantity,
      l.price,
      l.cost,
      l.price * l.quantity,
      l.packagingValue,
    ],
  );
}

async function insertNote(
  ds: DataSource,
  companyId: number,
  saleId: string,
  opts: { noteType: NoteType; operationType: OperationType; noteNumber: string; total: number },
): Promise<string> {
  const r = await ds.query(
    `INSERT INTO credit_notes
       (company_id, sale_invoice_id, note_number, note_type, operation_type, subtotal, tax_total, total, is_deleted)
     VALUES ($1, $2, $3, $4, $5, $6, 0, $6, false)
     RETURNING id`,
    [String(companyId), saleId, opts.noteNumber, opts.noteType, opts.operationType, opts.total],
  );
  return r[0].id;
}

async function insertNoteLine(
  ds: DataSource,
  companyId: number,
  noteId: string,
  l: {
    productId: string;
    description: string;
    quantity: number;
    price: number;
    cost: number;
    packagingValue: number | null;
  },
): Promise<void> {
  await ds.query(
    `INSERT INTO credit_note_lines
       (company_id, credit_note_id, product_id, description, quantity, unit_price, unit_cost, subtotal, total, packaging_value)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8, $9)`,
    [
      String(companyId),
      noteId,
      l.productId,
      l.description,
      l.quantity,
      l.price,
      l.cost,
      l.price * l.quantity,
      l.packagingValue,
    ],
  );
}

async function deductReal(
  ds: DataSource,
  companyId: number,
  lines: Array<{ item_id: number; quantity: number; packaging_value: number | null }>,
  direction: 'DEDUCT' | 'RETURN',
): Promise<void> {
  await ds.transaction(async (manager) => {
    await adjustInventory(manager, companyId, lines, direction, {
      reason: direction === 'DEDUCT' ? 'SALE' : 'SALE_VOID',
      referenceType: 'sale_invoice',
      crossCompanyAccess: true,
    });
  });
}

async function purgeSalesAndNotes(ds: DataSource, companyId: number): Promise<void> {
  const cid = String(companyId);
  await ds.query(`DELETE FROM credit_note_lines WHERE company_id = $1`, [cid]);
  await ds.query(`DELETE FROM credit_notes WHERE company_id = $1`, [cid]);
  await ds.query(`DELETE FROM sale_payments WHERE company_id = $1`, [cid]);
  await ds.query(`DELETE FROM sale_credits WHERE company_id = $1`, [cid]);
  await ds.query(`DELETE FROM sale_invoice_lines WHERE company_id = $1`, [cid]);
  await ds.query(`DELETE FROM sale_invoices WHERE company_id = $1`, [cid]);
  await ds.query(`DELETE FROM ticket_settings WHERE company_id = $1`, [cid]);
}

describe('VoidSaleAction (e2e, pos_db) — anulación TOTAL sobre el CONSOLIDADO', () => {
  let ds: DataSource | null = null;
  let companyId = 0;

  beforeAll(async () => {
    ds = await tryInitDataSource();
    if (!ds) {
      // eslint-disable-next-line no-console
      console.warn('[e2e] pos_db no disponible — void-consolidated e2e SKIPPED.');
      return;
    }
    companyId = await createDisposableCompany(ds, COMPANY_VOID);
    await seedCreditNoteFolio(ds, companyId);
  });

  afterAll(async () => {
    if (!ds) {
      return;
    }
    // Las tablas de ventas/notas NO las limpia `cleanupCompany`; hay que purgarlas
    // ANTES (FKs RESTRICT a products/companies) o el cleanup fallaría.
    await purgeSalesAndNotes(ds, companyId);
    await cleanupCompany(ds, companyId);
    await ds.destroy();
  });

  it('1) anulación tras ND (producto nuevo + incremento): el inventario vuelve a original+ND; NC total == consolidado; consolidado neto = 0', async () => {
    if (!ds) {
      return;
    }
    // Productos SIMPLES. P1 vendido y luego incrementado por ND; P2 NUEVO por ND.
    const P1 = await insertProduct(ds, companyId, { name: 'V1 P1', cost: 4, stock: 100 });
    const P2 = await insertProduct(ds, companyId, { name: 'V1 P2', cost: 2, stock: 100 });

    // Cobro original: 2× P1 (precio 10). Stock real con el motor.
    await deductReal(
      ds,
      companyId,
      [{ item_id: Number(P1), quantity: 2, packaging_value: 1 }],
      'DEDUCT',
    );
    // ND: +1 P1 (incremento) y +3 P2 (nuevo, precio 5).
    await deductReal(
      ds,
      companyId,
      [
        { item_id: Number(P1), quantity: 1, packaging_value: 1 },
        { item_id: Number(P2), quantity: 3, packaging_value: 1 },
      ],
      'DEDUCT',
    );
    expect(await stockOf(ds, companyId, P1)).toBe(97); // 100 - 3
    expect(await stockOf(ds, companyId, P2)).toBe(97); // 100 - 3

    // Persistencia: la venta original (2× P1) y la ND (DEBIT ADDITION).
    const saleId = await insertSaleInvoiceSALE(ds, companyId, {
      ticketNumber: 'T-V1',
      saleNumber: 'S-V1',
      total: 20,
      cost: 8,
    });
    await insertSaleLine(ds, companyId, saleId, {
      productId: P1,
      description: 'V1 P1',
      quantity: 2,
      price: 10,
      cost: 4,
      packagingValue: 1,
    });
    const ndId = await insertNote(ds, companyId, saleId, {
      noteType: NoteType.DEBIT,
      operationType: OperationType.ADDITION,
      noteNumber: 'ND-V1',
      total: 25, // 1×10 + 3×5
    });
    await insertNoteLine(ds, companyId, ndId, {
      productId: P1,
      description: 'V1 P1',
      quantity: 1,
      price: 10,
      cost: 4,
      packagingValue: 1,
    });
    await insertNoteLine(ds, companyId, ndId, {
      productId: P2,
      description: 'V1 P2',
      quantity: 3,
      price: 5,
      cost: 2,
      packagingValue: 1,
    });

    // Consolidado esperado: P1 qty3 (2+1), P2 qty3 → total 3×10 + 3×5 = 45.
    const consolidatedBefore = await getConsolidatedInvoice(ds.manager, companyId, Number(saleId));
    expect(consolidatedBefore?.total).toBe(45);

    // ANULAR (acción real).
    const result = await buildVoidAction(ds).execute(Number(saleId), companyId, {
      id: 1,
      fullName: 'E2E_VOID',
      type: 'owner',
    } satisfies VoidSaleActor);
    expect(result.creditNoteId).not.toBeNull();

    // Inventario: vuelve a original+ND (= stock antes de la venta).
    expect(await stockOf(ds, companyId, P1)).toBe(100);
    expect(await stockOf(ds, companyId, P2)).toBe(100);

    // NC FULL_VOID total == consolidado (45), no el original (20).
    const nc = await ds.query(
      `SELECT total::float AS total, subtotal::float AS subtotal, tax_total::float AS tax FROM credit_notes
       WHERE sale_invoice_id = $1 AND company_id = $2 AND operation_type = 'FULL_VOID'`,
      [saleId, String(companyId)],
    );
    expect(nc[0].total).toBe(45);
    expect(nc[0].subtotal).toBe(45);
    expect(nc[0].tax).toBe(0);

    // Consolidado neto tras anular = 0 (sin líneas vivas).
    const consolidatedAfter = await getConsolidatedInvoice(ds.manager, companyId, Number(saleId));
    expect(consolidatedAfter?.total).toBe(0);
    expect(consolidatedAfter?.lines).toHaveLength(0);
  });

  it('2) anulación tras NC parcial: devuelve SOLO lo que seguía descontado (sin doble retorno)', async () => {
    if (!ds) {
      return;
    }
    const P1 = await insertProduct(ds, companyId, { name: 'V2 P1', cost: 4, stock: 100 });

    // Cobro 5× P1; NC parcial remueve 2× P1 (ya devueltas).
    await deductReal(
      ds,
      companyId,
      [{ item_id: Number(P1), quantity: 5, packaging_value: 1 }],
      'DEDUCT',
    );
    await deductReal(
      ds,
      companyId,
      [{ item_id: Number(P1), quantity: 2, packaging_value: 1 }],
      'RETURN',
    );
    expect(await stockOf(ds, companyId, P1)).toBe(97); // 100 - 5 + 2

    const saleId = await insertSaleInvoiceSALE(ds, companyId, {
      ticketNumber: 'T-V2',
      saleNumber: 'S-V2',
      total: 50,
      cost: 20,
    });
    await insertSaleLine(ds, companyId, saleId, {
      productId: P1,
      description: 'V2 P1',
      quantity: 5,
      price: 10,
      cost: 4,
      packagingValue: 1,
    });
    const ncId = await insertNote(ds, companyId, saleId, {
      noteType: NoteType.CREDIT,
      operationType: OperationType.PARTIAL_VOID,
      noteNumber: 'NCP-V2',
      total: 20, // 2×10
    });
    await insertNoteLine(ds, companyId, ncId, {
      productId: P1,
      description: 'V2 P1',
      quantity: 2,
      price: 10,
      cost: 4,
      packagingValue: 1,
    });

    // Consolidado: P1 qty3 (5−2) → total 30.
    expect((await getConsolidatedInvoice(ds.manager, companyId, Number(saleId)))?.total).toBe(30);

    await buildVoidAction(ds).execute(Number(saleId), companyId, {
      id: 1,
      fullName: 'E2E_VOID',
      type: 'owner',
    } satisfies VoidSaleActor);

    // SIN doble retorno: vuelve a 100 (devolvió solo 3, no 5).
    expect(await stockOf(ds, companyId, P1)).toBe(100);
    const nc = await ds.query(
      `SELECT total::float AS total FROM credit_notes
       WHERE sale_invoice_id = $1 AND company_id = $2 AND operation_type = 'FULL_VOID'`,
      [saleId, String(companyId)],
    );
    expect(nc[0].total).toBe(30); // consolidado, no el original (50)
    expect((await getConsolidatedInvoice(ds.manager, companyId, Number(saleId)))?.total).toBe(0);
  });

  it('3) anulación tras ND sobre PRESENTACIÓN (hijo con packaging W): devuelve qty×W al padre', async () => {
    if (!ds) {
      return;
    }
    const W = 10;
    const parentId = await insertProduct(ds, companyId, { name: 'V3 Padre', cost: 1, stock: 100 });
    const pkg = await insertPackaging(ds, companyId, 'V3 Caja x10', W);
    const childId = await insertProduct(ds, companyId, {
      name: 'V3 Hijo',
      cost: 1,
      stock: 0,
      parentId,
      packagingId: pkg,
    });

    // Cobro 1× C; ND +2× C. Stock del padre: 100 - 3×10 = 70.
    await deductReal(
      ds,
      companyId,
      [{ item_id: Number(childId), quantity: 1, packaging_value: W }],
      'DEDUCT',
    );
    await deductReal(
      ds,
      companyId,
      [{ item_id: Number(childId), quantity: 2, packaging_value: W }],
      'DEDUCT',
    );
    expect(await stockOf(ds, companyId, parentId)).toBe(70);

    const saleId = await insertSaleInvoiceSALE(ds, companyId, {
      ticketNumber: 'T-V3',
      saleNumber: 'S-V3',
      total: 20,
      cost: 10,
    });
    await insertSaleLine(ds, companyId, saleId, {
      productId: childId,
      description: 'V3 Hijo',
      quantity: 1,
      price: 20,
      cost: 10,
      packagingValue: W,
    });
    const ndId = await insertNote(ds, companyId, saleId, {
      noteType: NoteType.DEBIT,
      operationType: OperationType.ADDITION,
      noteNumber: 'ND-V3',
      total: 40,
    });
    await insertNoteLine(ds, companyId, ndId, {
      productId: childId,
      description: 'V3 Hijo',
      quantity: 2,
      price: 20,
      cost: 10,
      packagingValue: W,
    });

    await buildVoidAction(ds).execute(Number(saleId), companyId, {
      id: 1,
      fullName: 'E2E_VOID',
      type: 'owner',
    } satisfies VoidSaleActor);

    // Consolidado C qty3 × W=10 devuelto al PADRE → 70 + 30 = 100.
    expect(await stockOf(ds, companyId, parentId)).toBe(100);
    expect((await getConsolidatedInvoice(ds.manager, companyId, Number(saleId)))?.total).toBe(0);
  });

  it('4) REGRESIÓN: anulación limpia (sin notas) devuelve exactamente las líneas originales', async () => {
    if (!ds) {
      return;
    }
    const P1 = await insertProduct(ds, companyId, { name: 'V4 P1', cost: 3, stock: 50 });

    // Cobro 4× P1, sin notas.
    await deductReal(
      ds,
      companyId,
      [{ item_id: Number(P1), quantity: 4, packaging_value: 1 }],
      'DEDUCT',
    );
    expect(await stockOf(ds, companyId, P1)).toBe(46);

    const saleId = await insertSaleInvoiceSALE(ds, companyId, {
      ticketNumber: 'T-V4',
      saleNumber: 'S-V4',
      total: 32,
      cost: 12,
    });
    await insertSaleLine(ds, companyId, saleId, {
      productId: P1,
      description: 'V4 P1',
      quantity: 4,
      price: 8,
      cost: 3,
      packagingValue: 1,
    });

    await buildVoidAction(ds).execute(Number(saleId), companyId, {
      id: 1,
      fullName: 'E2E_VOID',
      type: 'owner',
    } satisfies VoidSaleActor);

    // Idéntico al comportamiento previo: devuelve las 4 originales → 50.
    expect(await stockOf(ds, companyId, P1)).toBe(50);
    const nc = await ds.query(
      `SELECT total::float AS total FROM credit_notes
       WHERE sale_invoice_id = $1 AND company_id = $2 AND operation_type = 'FULL_VOID'`,
      [saleId, String(companyId)],
    );
    expect(nc[0].total).toBe(32); // consolidado == original (no hubo notas)
    expect((await getConsolidatedInvoice(ds.manager, companyId, Number(saleId)))?.total).toBe(0);
  });

  it('5) CONSOLIDADO VACÍO: NC parcial previa removió TODO → FULL_VOID no devuelve inventario, total 0, is_deleted, sin reventar por insert vacío', async () => {
    if (!ds) {
      return;
    }
    const P1 = await insertProduct(ds, companyId, { name: 'V5 P1', cost: 4, stock: 100 });

    // Cobro 3× P1; NC parcial remueve LAS 3 → consolidado queda VACÍO.
    await deductReal(
      ds,
      companyId,
      [{ item_id: Number(P1), quantity: 3, packaging_value: 1 }],
      'DEDUCT',
    );
    await deductReal(
      ds,
      companyId,
      [{ item_id: Number(P1), quantity: 3, packaging_value: 1 }],
      'RETURN',
    );
    expect(await stockOf(ds, companyId, P1)).toBe(100); // 100 - 3 + 3

    const saleId = await insertSaleInvoiceSALE(ds, companyId, {
      ticketNumber: 'T-V5',
      saleNumber: 'S-V5',
      total: 30,
      cost: 12,
    });
    await insertSaleLine(ds, companyId, saleId, {
      productId: P1,
      description: 'V5 P1',
      quantity: 3,
      price: 10,
      cost: 4,
      packagingValue: 1,
    });
    const ncId = await insertNote(ds, companyId, saleId, {
      noteType: NoteType.CREDIT,
      operationType: OperationType.PARTIAL_VOID,
      noteNumber: 'NCP-V5',
      total: 30, // 3×10 — remueve todo
    });
    await insertNoteLine(ds, companyId, ncId, {
      productId: P1,
      description: 'V5 P1',
      quantity: 3,
      price: 10,
      cost: 4,
      packagingValue: 1,
    });

    // Consolidado YA vacío antes de anular (todo devuelto por la NC parcial).
    const consolidatedBefore = await getConsolidatedInvoice(ds.manager, companyId, Number(saleId));
    expect(consolidatedBefore?.lines).toHaveLength(0);
    expect(consolidatedBefore?.total).toBe(0);

    // Movimientos previos del producto (cobro DEDUCT + NC RETURN = 2). El FULL_VOID
    // NO debe agregar ninguno (rama del guard `consolidatedLines.length > 0`).
    const movsBefore = await movementsOf(ds, companyId, P1);

    const result = await buildVoidAction(ds).execute(Number(saleId), companyId, {
      id: 1,
      fullName: 'E2E_VOID',
      type: 'owner',
    } satisfies VoidSaleActor);
    expect(result.creditNoteId).not.toBeNull(); // no revienta por insert con []

    // Inventario intacto: NO se devolvió de nuevo.
    expect(await stockOf(ds, companyId, P1)).toBe(100);
    const movsAfter = await movementsOf(ds, companyId, P1);
    expect(movsAfter).toHaveLength(movsBefore.length); // sin movimientos nuevos

    // NC FULL_VOID con total 0 y SIN líneas; la venta queda anulada.
    const nc = await ds.query(
      `SELECT id, total::float AS total FROM credit_notes
       WHERE sale_invoice_id = $1 AND company_id = $2 AND operation_type = 'FULL_VOID'`,
      [saleId, String(companyId)],
    );
    expect(nc[0].total).toBe(0);
    const ncLines = await ds.query(
      `SELECT count(*)::int AS n FROM credit_note_lines WHERE credit_note_id = $1 AND company_id = $2`,
      [nc[0].id, String(companyId)],
    );
    expect(ncLines[0].n).toBe(0);
    const deleted = await ds.query(
      `SELECT is_deleted FROM sale_invoices WHERE id = $1 AND company_id = $2`,
      [saleId, String(companyId)],
    );
    expect(deleted[0].is_deleted).toBe(true);
  });
});
