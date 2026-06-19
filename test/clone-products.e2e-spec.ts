import { BadRequestException, ForbiddenException } from '@nestjs/common';
import Big from 'big.js';
import type { DataSource } from 'typeorm';

import { CloneProductsToBranchAction } from '@/modules/products/actions/clone-products-to-branch.action';
import { adjustInventory } from '@/modules/products/internal/adjust-inventory.helper';

import {
  cleanupCompany,
  countRows,
  createDisposableBranch,
  createDisposableCompany,
  E2E_TABLES,
  insertCategory,
  insertCompanyMember,
  insertOwnerUser,
  insertPackaging,
  insertPrice,
  insertProduct,
  tryInitDataSource,
} from './helpers/e2e-db';

/**
 * FASE 1 (CLONAR) — e2e con BD REAL de `CloneProductsToBranchAction`.
 *
 * Verifica: clonado de catálogo completo, INDEPENDENCIA de inventarios (vender
 * en sucursal no toca al principal y al revés), clonado de familia (combo/
 * presentaciones) con `parent_id` recableado y precios con profit/margin
 * recalculados, colisiones omitidas con motivo, resolución de categoría/empaque
 * por nombre/valor en el destino, y permisos (origen no-principal, destino
 * no-sucursal / sin membresía).
 *
 * Skip limpio si no hay BD. Companies desechables, cleanup total en afterAll.
 */

const PRINCIPAL = '__E2E_CLONE_MAIN__';
const BRANCH = '__E2E_CLONE_BRANCH__';
const OTHER = '__E2E_CLONE_OTHER__';

const round2 = (b: Big): number => b.round(2, Big.roundHalfUp).toNumber();
const round4 = (b: Big): number => b.round(4, Big.roundHalfUp).toNumber();

describe('CloneProductsToBranchAction (e2e, pos_db) — FASE 1 clonar', () => {
  let ds: DataSource | null = null;
  let action: CloneProductsToBranchAction;
  let principalId = 0;
  let branchId = 0;
  // El actor debe ser un usuario REAL (company_members.user_id → users FK).
  let ACTOR = { id: 0, fullName: 'E2E_CLONE_OWNER' };

  beforeAll(async () => {
    ds = await tryInitDataSource();
    if (!ds) {
      // eslint-disable-next-line no-console
      console.warn('[e2e] pos_db no disponible — clone-products e2e SKIPPED.');
      return;
    }
    action = new CloneProductsToBranchAction(ds);
    principalId = await createDisposableCompany(ds, PRINCIPAL); // is_branch=false
    branchId = await createDisposableBranch(ds, BRANCH); // is_branch=true
    const userId = await insertOwnerUser(ds, principalId, 'clone');
    ACTOR = { id: userId, fullName: 'E2E_CLONE_OWNER' };
    await insertCompanyMember(ds, ACTOR.id, branchId);
  });

  afterAll(async () => {
    if (!ds) {
      return;
    }
    await cleanupCompany(ds, principalId);
    await cleanupCompany(ds, branchId);
    const other = await ds.query(`SELECT id FROM companies WHERE name = $1`, [OTHER]);
    for (const row of other) {
      await cleanupCompany(ds, parseInt(row.id, 10));
    }
    await ds.destroy();
  });

  // Lecturas ──────────────────────────────────────────────────────────────
  async function branchProductByName(name: string) {
    return ds!.query(
      `SELECT * FROM products WHERE company_id = $1 AND lower(btrim(name)) = lower(btrim($2)) AND is_archived = false`,
      [String(branchId), name],
    );
  }
  async function pricesOf(companyId: number, productId: string) {
    return ds!.query(
      `SELECT sale_price::float AS sale, profit::float AS profit, margin::float AS margin
       FROM product_prices WHERE product_id = $1 AND company_id = $2 ORDER BY sale_price`,
      [productId, String(companyId)],
    );
  }
  async function stockOf(companyId: number, productId: string): Promise<number> {
    const r = await ds!.query(
      `SELECT stock::float AS stock FROM products WHERE id = $1 AND company_id = $2`,
      [productId, String(companyId)],
    );
    return parseFloat(r[0].stock);
  }

  it('clona TODO el catálogo → la sucursal recibe copias independientes', async () => {
    if (!ds) return;
    const pA = await insertProduct(ds, principalId, {
      name: 'Clon Total A',
      cost: 2,
      stock: 100,
      skuCode: 'CT-A',
    });
    await insertPrice(ds, principalId, pA, 5, 3, round4(new Big(3).div(5).times(100)));
    const pB = await insertProduct(ds, principalId, {
      name: 'Clon Total B',
      cost: 4,
      stock: 50,
      skuCode: 'CT-B',
    });
    await insertPrice(ds, principalId, pB, 10, 6, round4(new Big(6).div(10).times(100)));

    const res = await action.execute(principalId, branchId, undefined, ACTOR);
    expect(res.created).toBe(2);
    expect(res.skipped).toHaveLength(0);

    const clonedA = await branchProductByName('Clon Total A');
    const clonedB = await branchProductByName('Clon Total B');
    expect(clonedA).toHaveLength(1);
    expect(clonedB).toHaveLength(1);
    // Son filas NUEVAS (distinto id) en la company sucursal.
    expect(clonedA[0].company_id).toBe(String(branchId));
    expect(clonedA[0].id).not.toBe(pA);
    expect(parseFloat(clonedA[0].cost)).toBe(2);
    expect(parseFloat(clonedA[0].stock)).toBe(100);
    // Marca de COPIA: registra la company de origen (el principal) → el front
    // lo muestra como "Copia" (is_clone), distinto de "Propio".
    expect(clonedA[0].cloned_from_company_id).toBe(String(principalId));

    // Precios clonados con profit/margin recalculados contra el cost clonado.
    const pricesA = await pricesOf(branchId, clonedA[0].id);
    expect(pricesA).toHaveLength(1);
    expect(pricesA[0].profit).toBe(round2(new Big(5).minus(2)));
    expect(pricesA[0].margin).toBe(round4(new Big(3).div(5).times(100)));
  });

  it('INDEPENDENCIA: vender en la sucursal baja SU stock y NO el del principal (y al revés)', async () => {
    if (!ds) return;
    const principalProd = await insertProduct(ds, principalId, {
      name: 'Independiente',
      cost: 1,
      stock: 100,
      skuCode: 'IND-1',
    });
    await insertPrice(ds, principalId, principalProd, 3, 2, round4(new Big(2).div(3).times(100)));

    const res = await action.execute(principalId, branchId, [Number(principalProd)], ACTOR);
    expect(res.created).toBe(1);

    const branchProd = (await branchProductByName('Independiente'))[0];
    expect(branchProd.id).not.toBe(principalProd);

    // Vender (DEDUCT) 10 en la SUCURSAL.
    await ds.transaction(async (manager) => {
      await adjustInventory(
        manager,
        branchId,
        [{ item_id: Number(branchProd.id), quantity: 10, packaging_value: 1 }],
        'DEDUCT',
        { reason: 'SALE', referenceType: 'sale_invoice' },
      );
    });
    expect(await stockOf(branchId, branchProd.id)).toBe(90);
    expect(await stockOf(principalId, principalProd)).toBe(100); // principal intacto

    // Vender (DEDUCT) 25 en el PRINCIPAL.
    await ds.transaction(async (manager) => {
      await adjustInventory(
        manager,
        principalId,
        [{ item_id: Number(principalProd), quantity: 25, packaging_value: 1 }],
        'DEDUCT',
        { reason: 'SALE', referenceType: 'sale_invoice' },
      );
    });
    expect(await stockOf(principalId, principalProd)).toBe(75);
    expect(await stockOf(branchId, branchProd.id)).toBe(90); // sucursal intacta
  });

  it('clona una FAMILIA (base + presentaciones) recableando parent_id; precios con profit/margin', async () => {
    if (!ds) return;
    const pkgParent = await insertPackaging(ds, principalId, 'Caja Fam 1000', 1000);
    const pkgChild = await insertPackaging(ds, principalId, 'Media Fam 500', 500);
    const base = await insertProduct(ds, principalId, {
      name: 'Familia Base',
      cost: 10,
      stock: 100,
      skuCode: 'FAM-BASE',
      packagingId: pkgParent,
      productType: 'SIMPLE',
    });
    const child = await insertProduct(ds, principalId, {
      name: 'Familia Presentacion',
      cost: 5,
      stock: 0,
      skuCode: 'FAM-CHILD',
      parentId: base,
      packagingId: pkgChild,
    });
    await insertPrice(ds, principalId, base, 20, 10, round4(new Big(10).div(20).times(100)));
    await insertPrice(ds, principalId, child, 12, 7, round4(new Big(7).div(12).times(100)));

    // Clonar pidiendo SOLO el id del HIJO → debe clonar la familia entera.
    const res = await action.execute(principalId, branchId, [Number(child)], ACTOR);
    expect(res.created).toBe(2);
    expect(res.skipped).toHaveLength(0);

    const clonedBase = (await branchProductByName('Familia Base'))[0];
    const clonedChild = (await branchProductByName('Familia Presentacion'))[0];
    expect(clonedBase).toBeDefined();
    expect(clonedChild).toBeDefined();

    // parent_id del hijo clonado apunta al BASE clonado (no al id de origen).
    expect(clonedChild.parent_id).toBe(clonedBase.id);
    expect(clonedBase.parent_id).toBeNull();
    expect(clonedChild.parent_id).not.toBe(base);

    // Precios del hijo clonado: profit/margin recalculados contra cost=5.
    const childPrices = await pricesOf(branchId, clonedChild.id);
    expect(childPrices).toHaveLength(1);
    expect(childPrices[0].profit).toBe(round2(new Big(12).minus(5)));
    expect(childPrices[0].margin).toBe(round4(new Big(7).div(12).times(100)));
  });

  it('clona un COMBO (product_type=COMBO con hijos) recableando parent_id', async () => {
    if (!ds) return;
    const combo = await insertProduct(ds, principalId, {
      name: 'Combo Padre',
      cost: 0,
      stock: 0,
      skuCode: 'COMBO-1',
      productType: 'COMBO',
    });
    const comp1 = await insertProduct(ds, principalId, {
      name: 'Combo Hijo 1',
      cost: 3,
      stock: 10,
      skuCode: 'COMBO-C1',
      parentId: combo,
    });
    await insertPrice(ds, principalId, comp1, 6, 3, round4(new Big(3).div(6).times(100)));

    const res = await action.execute(principalId, branchId, [Number(combo)], ACTOR);
    expect(res.created).toBe(2);

    const clonedCombo = (await branchProductByName('Combo Padre'))[0];
    const clonedComp = (await branchProductByName('Combo Hijo 1'))[0];
    expect(clonedCombo.product_type).toBe('COMBO');
    expect(clonedComp.parent_id).toBe(clonedCombo.id);
  });

  it('COLISIÓN por name/sku/barcode → omite y reporta el motivo; lo existente queda intacto', async () => {
    if (!ds) return;
    // name collision: la sucursal YA tiene "Colision Nombre".
    const branchExisting = await insertProduct(ds, branchId, {
      name: 'Colision Nombre',
      cost: 99,
      stock: 7,
    });
    const principalName = await insertProduct(ds, principalId, {
      name: 'Colision Nombre',
      cost: 1,
      stock: 1,
      skuCode: 'COL-N',
    });
    await insertPrice(ds, principalId, principalName, 3, 2, round4(new Big(2).div(3).times(100)));

    // sku collision: misma sku activa en la sucursal.
    await insertProduct(ds, branchId, { name: 'Sucursal SKU X', cost: 1, skuCode: 'COL-SKU' });
    const principalSku = await insertProduct(ds, principalId, {
      name: 'Principal SKU X',
      cost: 1,
      skuCode: 'COL-SKU',
    });
    await insertPrice(ds, principalId, principalSku, 3, 2, round4(new Big(2).div(3).times(100)));

    // barcode collision.
    await insertProduct(ds, branchId, { name: 'Sucursal BAR Y', cost: 1, barCode: 'COL-BAR' });
    const principalBar = await insertProduct(ds, principalId, {
      name: 'Principal BAR Y',
      cost: 1,
      barCode: 'COL-BAR',
    });
    await insertPrice(ds, principalId, principalBar, 3, 2, round4(new Big(2).div(3).times(100)));

    const res = await action.execute(
      principalId,
      branchId,
      [Number(principalName), Number(principalSku), Number(principalBar)],
      ACTOR,
    );
    expect(res.created).toBe(0);
    expect(res.skipped).toHaveLength(3);
    const byReason = new Map(res.skipped.map((s) => [s.reason, s.name]));
    expect(byReason.get('name')).toBe('Colision Nombre');
    expect(byReason.get('sku')).toBe('Principal SKU X');
    expect(byReason.get('barcode')).toBe('Principal BAR Y');

    // Lo existente en la sucursal NO se pisó (cost/stock intactos).
    const stillThere = await ds.query(
      `SELECT cost::float AS cost, stock::float AS stock FROM products WHERE id = $1`,
      [branchExisting],
    );
    expect(parseFloat(stillThere[0].cost)).toBe(99);
    expect(parseFloat(stillThere[0].stock)).toBe(7);
    // No se duplicó "Colision Nombre" en la sucursal.
    expect(await branchProductByName('Colision Nombre')).toHaveLength(1);
  });

  it('categoría y empaque se crean en la sucursal por nombre/valor (no se reusa el id del origen)', async () => {
    if (!ds) return;
    const catSource = await insertCategory(ds, principalId, 'Lacteos');
    const pkgSource = await insertPackaging(ds, principalId, 'Bolsa 250', 250);
    const prod = await insertProduct(ds, principalId, {
      name: 'Con Categoria y Empaque',
      cost: 2,
      stock: 10,
      skuCode: 'CCE-1',
      categoryId: catSource,
      packagingId: pkgSource,
    });
    await insertPrice(ds, principalId, prod, 5, 3, round4(new Big(3).div(5).times(100)));

    const res = await action.execute(principalId, branchId, [Number(prod)], ACTOR);
    expect(res.created).toBe(1);

    const cloned = (await branchProductByName('Con Categoria y Empaque'))[0];

    // Categoría: nueva en la sucursal, mismo nombre, distinto id que el origen.
    expect(cloned.category_id).not.toBeNull();
    expect(cloned.category_id).not.toBe(catSource);
    const cat = await ds.query(`SELECT company_id, name FROM categories WHERE id = $1`, [
      cloned.category_id,
    ]);
    expect(cat[0].company_id).toBe(String(branchId));
    expect(cat[0].name).toBe('Lacteos');

    // Empaque: nuevo en la sucursal, mismo value, distinto id que el origen.
    expect(cloned.packaging_id).not.toBeNull();
    expect(cloned.packaging_id).not.toBe(pkgSource);
    const pkg = await ds.query(`SELECT company_id, value::float AS value FROM packagings WHERE id = $1`, [
      cloned.packaging_id,
    ]);
    expect(pkg[0].company_id).toBe(String(branchId));
    expect(pkg[0].value).toBe(250);
  });

  it('PERMISOS: origen que NO es el principal → BadRequest', async () => {
    if (!ds) return;
    // El "origen" es la sucursal (is_branch=true) → no permitido como origen.
    await expect(
      action.execute(branchId, principalId, undefined, ACTOR),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('PERMISOS: destino que NO es sucursal del owner (sin membresía) → Forbidden', async () => {
    if (!ds) return;
    const otherId = await createDisposableBranch(ds, OTHER); // sucursal, pero SIN membresía del actor
    await expect(
      action.execute(principalId, otherId, undefined, ACTOR),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await cleanupCompany(ds, otherId);
  });

  it('PERMISOS: destino que es miembro pero NO es sucursal (is_branch=false) → BadRequest', async () => {
    if (!ds) return;
    const principalAsDest = await createDisposableCompany(ds, OTHER); // is_branch=false
    await insertCompanyMember(ds, ACTOR.id, principalAsDest);
    await expect(
      action.execute(principalId, principalAsDest, undefined, ACTOR),
    ).rejects.toBeInstanceOf(BadRequestException);
    await cleanupCompany(ds, principalAsDest);
  });

  it('cleanup deja principal y sucursal sin rastro', async () => {
    if (!ds) return;
    await cleanupCompany(ds, principalId);
    await cleanupCompany(ds, branchId);
    for (const table of E2E_TABLES) {
      expect(await countRows(ds, table, principalId)).toBe(0);
      expect(await countRows(ds, table, branchId)).toBe(0);
    }
    // Recreamos para que el afterAll re-limpie sin fallo (incluido el user,
    // que cleanupCompany(principalId) borró).
    principalId = await createDisposableCompany(ds, PRINCIPAL);
    branchId = await createDisposableBranch(ds, BRANCH);
    ACTOR = { id: await insertOwnerUser(ds, principalId, 'clone2'), fullName: 'E2E_CLONE_OWNER' };
    await insertCompanyMember(ds, ACTOR.id, branchId);
  });
});
