import type { DataSource } from 'typeorm';

import { adjustInventory } from '@/modules/products/internal/adjust-inventory.helper';
import { ShareProductsToBranchAction } from '@/modules/products/actions/share-products-to-branch.action';
import { FindAllProductsAction } from '@/modules/products/actions/find-all-products.action';
import { UpdateProductAction } from '@/modules/products/actions/update-product.action';

import {
  tryInitDataSource,
  createDisposableCompany,
  createDisposableBranch,
  insertOwnerUser,
  insertCompanyMember,
  insertProduct,
  insertPackaging,
  cleanupCompany,
} from './helpers/e2e-db';

/**
 * FASE 2 (COMPARTIR) — e2e contra pos_db. Verifica que un producto COMPARTIDO
 * del principal sea visible y vendible desde la sucursal, descontando el stock
 * del PRINCIPAL (única fuente de verdad), y que la sucursal NO pueda editarlo
 * (solo lectura/venta).
 */
describe('Compartir inventario entre companies (e2e, pos_db) — FASE 2', () => {
  let ds: DataSource | null = null;
  let share: ShareProductsToBranchAction;
  let findAll: FindAllProductsAction;
  let updateProduct: UpdateProductAction;
  const created: number[] = [];

  beforeAll(async () => {
    ds = await tryInitDataSource();
    if (ds) {
      share = new ShareProductsToBranchAction(ds);
      findAll = new FindAllProductsAction(ds);
      updateProduct = new UpdateProductAction(ds);
    }
  });

  afterAll(async () => {
    if (!ds) {
      return;
    }
    for (const id of created) {
      await cleanupCompany(ds, id);
    }
    await ds.destroy();
  });

  // Crea un par principal+sucursal con owner miembro de ambas. Devuelve ids +
  // actor. Registra las companies para limpieza.
  const setupPair = async (tag: string) => {
    const principal = await createDisposableCompany(ds!, `__E2E_SHARE_${tag}_A__`);
    const branch = await createDisposableBranch(ds!, `__E2E_SHARE_${tag}_B__`);
    created.push(principal, branch);
    const ownerId = await insertOwnerUser(ds!, principal, `share_${tag}`);
    await insertCompanyMember(ds!, ownerId, principal);
    await insertCompanyMember(ds!, ownerId, branch);
    return { principal, branch, actor: { id: ownerId, fullName: 'E2E_SHARE' } };
  };

  const stockOf = async (productId: string): Promise<number> => {
    const r = await ds!.query(`SELECT stock::float AS s FROM products WHERE id = $1`, [productId]);
    return r[0]?.s ?? null;
  };

  const maybe = (name: string, fn: () => Promise<void>) =>
    it(name, async () => {
      if (!ds) {
        console.warn('pos_db no disponible — test omitido');
        return;
      }
      await fn();
    });

  maybe(
    'compartir TODO: la sucursal ve los productos del principal (incl. futuros) con is_shared',
    async () => {
      const { principal, branch, actor } = await setupPair('ALL');
      const p1 = await insertProduct(ds!, principal, {
        name: 'Compartido 1',
        cost: 10,
        stock: 100,
      });

      const res = await share.execute(principal, branch, undefined, actor);
      expect(res.mode).toBe('all');

      // Producto creado DESPUÉS de compartir-todo: también debe verse.
      const p2 = await insertProduct(ds!, principal, { name: 'Compartido 2', cost: 5, stock: 50 });

      const catalogB = await findAll.execute(branch, {});
      const b1 = catalogB.find((p) => String(p.id) === p1);
      const b2 = catalogB.find((p) => String(p.id) === p2);
      expect(b1).toBeDefined();
      expect(b2).toBeDefined();
      // [[AISLAMIENTO-CROSS-TENANT]] — antes B NO veía nada de A; CON share SÍ.
      expect((b1 as unknown as { is_shared: boolean }).is_shared).toBe(true);
      expect((b1 as unknown as { owner_company_id: number }).owner_company_id).toBe(principal);

      // En el principal, su propio producto NO es compartido.
      const catalogA = await findAll.execute(principal, {});
      const a1 = catalogA.find((p) => String(p.id) === p1) as unknown as { is_shared: boolean };
      expect(a1.is_shared).toBe(false);
    },
  );

  maybe(
    'la sucursal vende un producto compartido → descuenta del stock del PRINCIPAL',
    async () => {
      const { principal, branch, actor } = await setupPair('SELL');
      const pid = await insertProduct(ds!, principal, {
        name: 'Vender compartido',
        cost: 10,
        stock: 100,
      });
      await share.execute(principal, branch, [Number(pid)], actor);

      // La sucursal (branch) vende 5 unidades del producto compartido.
      await ds!.transaction(async (m) => {
        await adjustInventory(m, branch, [{ item_id: Number(pid), quantity: 5 }], 'DEDUCT', {
          reason: 'SALE',
          referenceType: 'sale_invoice',
          crossCompanyAccess: true,
        });
      });

      // [[AISLAMIENTO-CROSS-TENANT]] — antes B no podía tocar stock de A;
      // CON share el descuento pega en la fila del PRINCIPAL.
      expect(await stockOf(pid)).toBe(95);

      // RETURN cross-company (lo que hacen void-sale / update-sale al anular
      // o editar): la devolución de stock debe reponer en el PRINCIPAL.
      await ds!.transaction(async (m) => {
        await adjustInventory(m, branch, [{ item_id: Number(pid), quantity: 5 }], 'RETURN', {
          reason: 'SALE_VOID',
          referenceType: 'credit_note',
          crossCompanyAccess: true,
        });
      });
      expect(await stockOf(pid)).toBe(100);
    },
  );

  maybe(
    'presentación de un producto compartido: vender el hijo en la sucursal descuenta el PADRE del principal',
    async () => {
      const { principal, branch, actor } = await setupPair('PRES');
      const base = await insertProduct(ds!, principal, {
        name: 'Base compartida',
        cost: 20,
        stock: 1000,
      });
      const pkg = await insertPackaging(ds!, principal, 'Libra 500g', 500);
      const child = await insertProduct(ds!, principal, {
        name: 'Presentación 500g',
        cost: 10000,
        stock: 0,
        parentId: base,
        packagingId: pkg,
      });
      // Compartir TODO incluye base + hijo.
      await share.execute(principal, branch, undefined, actor);

      await ds!.transaction(async (m) => {
        await adjustInventory(m, branch, [{ item_id: Number(child), quantity: 1 }], 'DEDUCT', {
          reason: 'SALE',
          referenceType: 'sale_invoice',
          crossCompanyAccess: true,
        });
      });

      // 1 libra × 500 = 500 descontados del PADRE en el principal.
      expect(await stockOf(base)).toBe(500);
      // El hijo no guarda stock propio.
      expect(await stockOf(child)).toBe(0);
    },
  );

  maybe('compartir UNO: solo ese producto se ve en la sucursal', async () => {
    const { principal, branch, actor } = await setupPair('ONE');
    const p1 = await insertProduct(ds!, principal, { name: 'Solo este', cost: 10, stock: 10 });
    const p2 = await insertProduct(ds!, principal, { name: 'Este no', cost: 10, stock: 10 });

    const res = await share.execute(principal, branch, [Number(p1)], actor);
    expect(res.mode).toBe('products');

    const catalogB = await findAll.execute(branch, {});
    expect(catalogB.some((p) => String(p.id) === p1)).toBe(true);
    expect(catalogB.some((p) => String(p.id) === p2)).toBe(false);
  });

  maybe('la sucursal NO puede editar un producto compartido (solo lectura)', async () => {
    const { principal, branch, actor } = await setupPair('RO');
    const pid = await insertProduct(ds!, principal, { name: 'Solo lectura', cost: 10, stock: 10 });
    await share.execute(principal, branch, [Number(pid)], actor);

    // Editar desde la sucursal: el producto es de A, no se encuentra en B.
    await expect(
      updateProduct.execute(Number(pid), { name: 'Hackeado' }, branch, actor),
    ).rejects.toThrow();
    // El nombre en el principal NO cambió.
    const r = await ds!.query(`SELECT name FROM products WHERE id = $1`, [pid]);
    expect(r[0].name).toBe('Solo lectura');
  });

  maybe('idempotencia: compartir-todo dos veces no duplica', async () => {
    const { principal, branch, actor } = await setupPair('IDEM');
    await insertProduct(ds!, principal, { name: 'Idem', cost: 1, stock: 1 });
    await share.execute(principal, branch, undefined, actor);
    await share.execute(principal, branch, undefined, actor);
    const rows = await ds!.query(
      `SELECT count(*)::int AS n FROM inventory_shares
             WHERE source_company_id = $1 AND target_company_id = $2 AND product_id IS NULL`,
      [String(principal), String(branch)],
    );
    expect(rows[0].n).toBe(1);
  });

  maybe('permisos: origen NO principal o sucursal no-miembro → rechazado', async () => {
    const { principal, branch, actor } = await setupPair('PERM');
    // Origen = sucursal (no principal) → rechazado.
    await expect(share.execute(branch, principal, undefined, actor)).rejects.toThrow();
    // Destino = sucursal de la que el owner NO es miembro → rechazado.
    const otherBranch = await createDisposableBranch(ds!, '__E2E_SHARE_PERM_OTHER__');
    created.push(otherBranch);
    await expect(share.execute(principal, otherBranch, undefined, actor)).rejects.toThrow();
  });
});
