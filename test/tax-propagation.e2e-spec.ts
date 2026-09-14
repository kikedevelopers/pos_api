import type { DataSource } from 'typeorm';

import { CreateProductAction } from '@/modules/products/actions/create-product.action';
import { UpdateProductAction } from '@/modules/products/actions/update-product.action';

import {
  cleanupCompany,
  createDisposableCompany,
  E2E_ACTOR,
  insertPackaging,
  insertPrice,
  insertProduct,
  tryInitDataSource,
} from './helpers/e2e-db';

/**
 * E2E con BD REAL (pos_db): la configuración fiscal (IVA) de un producto BASE se
 * propaga a TODA su familia de presentaciones.
 *
 * Regla: una presentación está SIEMPRE amarrada al IVA de su base. Si el base
 * cambia de tarifa (19% → 5% → Exento), cada presentación adopta la nueva y el
 * desglose base/IVA de sus precios se reajusta al nuevo % (sale_price intacto).
 * Al crear una presentación, hereda la tarifa vigente del base.
 *
 * Patrón anti-CI-rojo: sin BD el describe se SKIPea. Companies desechables
 * borradas en afterAll. El catálogo tax_rates lo siembra la migración.
 */

const COMPANY_NAME = '__E2E_TAX__';
const COMPANY_NAME_B = '__E2E_TAX2__';

// base = sale/(1+rate/100) redondeada a 2; iva = sale - base.
function expectedBreakdown(sale: number, rate: number): { base: number; iva: number } {
  if (rate <= 0) return { base: Number(sale.toFixed(2)), iva: 0 };
  const base = Number((sale / (1 + rate / 100)).toFixed(2));
  return { base, iva: Number((sale - base).toFixed(2)) };
}

describe('Tax config propagation base → presentaciones (e2e, pos_db)', () => {
  let ds: DataSource | null = null;
  let companyId = 0;
  let createAction: CreateProductAction;
  let updateAction: UpdateProductAction;
  let IVA_19 = 0;
  let IVA_5 = 0;
  let EXEMPT = 0;

  beforeAll(async () => {
    ds = await tryInitDataSource();
    if (!ds) {
      // eslint-disable-next-line no-console
      console.warn('[e2e] pos_db no disponible — tax-propagation e2e SKIPPED.');
      return;
    }
    companyId = await createDisposableCompany(ds, COMPANY_NAME);
    // La FE debe estar activa para poder asignar una tarifa al base.
    await ds.query(`UPDATE companies SET electronic_billing_enabled = true WHERE id = $1`, [
      String(companyId),
    ]);
    const rates = await ds.query(`SELECT id, code FROM tax_rates`);
    const byCode = (c: string) => Number(rates.find((r: { code: string }) => r.code === c)?.id ?? 0);
    IVA_19 = byCode('IVA_19');
    IVA_5 = byCode('IVA_5');
    EXEMPT = byCode('EXEMPT');
    createAction = new CreateProductAction(ds);
    updateAction = new UpdateProductAction(ds);
  });

  afterAll(async () => {
    if (!ds) return;
    await cleanupCompany(ds, companyId);
    const leftover = await ds.query(`SELECT id FROM companies WHERE name = $1`, [COMPANY_NAME_B]);
    for (const row of leftover) {
      await cleanupCompany(ds, parseInt(row.id, 10));
    }
    await ds.destroy();
  });

  async function taxRateIdOf(cid: number, productId: string): Promise<number | null> {
    const r = await ds!.query(
      `SELECT tax_rate_id FROM products WHERE id = $1 AND company_id = $2`,
      [productId, String(cid)],
    );
    return r[0]?.tax_rate_id != null ? Number(r[0].tax_rate_id) : null;
  }
  async function pricesOf(cid: number, productId: string) {
    return ds!.query(
      `SELECT sale_price::float AS sale, taxable_base::float AS base, tax_amount::float AS iva,
              iva_percentage::float AS pct
       FROM product_prices WHERE product_id = $1 AND company_id = $2 ORDER BY sale_price`,
      [productId, String(cid)],
    );
  }

  /** Cada precio del hijo: base/iva desglosados al `rate`, sale_price intacto. */
  async function expectChildPrices(cid: number, childId: string, rate: number) {
    const prices = await pricesOf(cid, childId);
    for (const p of prices) {
      const { base, iva } = expectedBreakdown(p.sale, rate);
      expect(p.base).toBe(base);
      expect(p.iva).toBe(iva);
      expect(p.pct).toBe(rate);
      expect(Number((p.base + p.iva).toFixed(2))).toBe(p.sale); // invariante
    }
  }

  async function makeFamily(prefix: string) {
    const pkgParent = await insertPackaging(ds!, companyId, `${prefix} caja`, 1000);
    const pkg500 = await insertPackaging(ds!, companyId, `${prefix} media`, 500);
    const parentId = await insertProduct(ds!, companyId, {
      name: `${prefix} base`,
      cost: 1000,
      stock: 50,
      packagingId: pkgParent,
    });
    const childA = await insertProduct(ds!, companyId, {
      name: `${prefix} hijo A`,
      cost: 500,
      packagingId: pkg500,
      parentId,
    });
    // Precios "feos" a propósito para ejercitar el redondeo/invariante.
    await insertPrice(ds!, companyId, childA, 11900, 0, 0);
    await insertPrice(ds!, companyId, childA, 999, 0, 0);
    return { parentId, childA };
  }

  it('FORM: asignar IVA 19% al base → los hijos lo heredan y sus precios se desglosan', async () => {
    if (!ds) return;
    const { parentId, childA } = await makeFamily('P19');

    await updateAction.execute(Number(parentId), { tax_rate_id: IVA_19 }, companyId, E2E_ACTOR);

    expect(await taxRateIdOf(companyId, parentId)).toBe(IVA_19);
    expect(await taxRateIdOf(companyId, childA)).toBe(IVA_19);
    await expectChildPrices(companyId, childA, 19);
  });

  it('cambiar el IVA del base 19% → 5% reajusta toda la familia', async () => {
    if (!ds) return;
    const { parentId, childA } = await makeFamily('P519');
    await updateAction.execute(Number(parentId), { tax_rate_id: IVA_19 }, companyId, E2E_ACTOR);

    await updateAction.execute(Number(parentId), { tax_rate_id: IVA_5 }, companyId, E2E_ACTOR);

    expect(await taxRateIdOf(companyId, childA)).toBe(IVA_5);
    await expectChildPrices(companyId, childA, 5);
  });

  it('cambiar el base a Exento pone el IVA de los hijos en 0 (base = precio)', async () => {
    if (!ds) return;
    const { parentId, childA } = await makeFamily('PEX');
    await updateAction.execute(Number(parentId), { tax_rate_id: IVA_19 }, companyId, E2E_ACTOR);

    await updateAction.execute(Number(parentId), { tax_rate_id: EXEMPT }, companyId, E2E_ACTOR);

    expect(await taxRateIdOf(companyId, childA)).toBe(EXEMPT);
    await expectChildPrices(companyId, childA, 0);
  });

  it('CREATE presentación: hereda la tarifa VIGENTE del base (ignora lo que mande el cliente)', async () => {
    if (!ds) return;
    const pkgParent = await insertPackaging(ds, companyId, 'CRE caja', 1000);
    const pkg500 = await insertPackaging(ds, companyId, 'CRE media', 500);
    const parentId = await insertProduct(ds, companyId, {
      name: 'CRE base',
      cost: 1000,
      stock: 10,
      packagingId: pkgParent,
    });
    await updateAction.execute(Number(parentId), { tax_rate_id: IVA_19 }, companyId, E2E_ACTOR);

    // El cliente intenta forzar EXEMPT en la presentación: se ignora, hereda 19%.
    const child = await createAction.execute(
      {
        name: 'CRE hijo',
        cost: 500,
        stock: 0,
        parent_id: Number(parentId),
        packaging_id: Number(pkg500),
        tax_rate_id: EXEMPT,
        prices: [{ sale_price: 11900 }],
      },
      companyId,
      E2E_ACTOR,
    );

    expect(await taxRateIdOf(companyId, String(child.id))).toBe(IVA_19);
    await expectChildPrices(companyId, String(child.id), 19);
  });

  it('editar un HIJO directo NO cambia su IVA (sigue amarrado al base)', async () => {
    if (!ds) return;
    const { parentId, childA } = await makeFamily('PHIJO');
    await updateAction.execute(Number(parentId), { tax_rate_id: IVA_19 }, companyId, E2E_ACTOR);

    // El cliente intenta ponerle EXEMPT al hijo: se ignora, sigue 19% del base.
    await updateAction.execute(
      Number(childA),
      { tax_rate_id: EXEMPT, name: 'PHIJO hijo A ren' },
      companyId,
      E2E_ACTOR,
    );

    expect(await taxRateIdOf(companyId, childA)).toBe(IVA_19);
    await expectChildPrices(companyId, childA, 19);
  });

  it('FE apagada: asignar IVA al base → 403 (no confía en el front)', async () => {
    if (!ds) return;
    const { parentId } = await makeFamily('POFF');
    await ds.query(`UPDATE companies SET electronic_billing_enabled = false WHERE id = $1`, [
      String(companyId),
    ]);

    await expect(
      updateAction.execute(Number(parentId), { tax_rate_id: IVA_19 }, companyId, E2E_ACTOR),
    ).rejects.toMatchObject({ status: 403 });

    await ds.query(`UPDATE companies SET electronic_billing_enabled = true WHERE id = $1`, [
      String(companyId),
    ]);
  });

  it('multi-tenant: la propagación filtra company_id — hijo de otra company no se toca', async () => {
    if (!ds) return;
    const { parentId } = await makeFamily('PMT');
    const companyB = await createDisposableCompany(ds, COMPANY_NAME_B);
    const pkgB = await insertPackaging(ds, companyB, 'MT B media', 500);
    // Hijo en B colgado del padre de A (cross-tenant a propósito).
    const childB = await insertProduct(ds, companyB, {
      name: 'MT B hijo',
      cost: 500,
      packagingId: pkgB,
      parentId,
    });
    await insertPrice(ds, companyB, childB, 11900, 0, 0);

    await updateAction.execute(Number(parentId), { tax_rate_id: IVA_19 }, companyId, E2E_ACTOR);

    // El hijo de B queda intacto: la propagación de A NO le puso el IVA 19%.
    expect(await taxRateIdOf(companyB, childB)).toBeNull();
    const [priceB] = await pricesOf(companyB, childB);
    expect(priceB.iva).toBe(0);
    expect(priceB.pct).toBe(0);

    await cleanupCompany(ds, companyB);
  });
});
