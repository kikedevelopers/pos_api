import { propagateTaxToChildren } from '../propagate-tax.helper';

// Manager falso: `find` devuelve hijos y luego sus precios según la entidad
// pedida; `update` registra las llamadas para inspeccionarlas.
function buildManager(children: Array<{ id: string }>, prices: Array<{ id: string; sale_price: number }>) {
  const updates: Array<{ where: unknown; set: Record<string, unknown> }> = [];
  const manager = {
    find: jest.fn((entity: { name?: string }) => {
      const name = typeof entity === 'function' ? (entity as { name: string }).name : '';
      if (name === 'Product') return Promise.resolve(children);
      if (name === 'ProductPrice') return Promise.resolve(prices);
      return Promise.resolve([]);
    }),
    update: jest.fn((_entity: unknown, where: unknown, set: Record<string, unknown>) => {
      updates.push({ where, set });
      return Promise.resolve({ affected: 1 });
    }),
  };
  return { manager, updates };
}

describe('propagateTaxToChildren', () => {
  it('sin hijos: no hace nada', async () => {
    const { manager } = buildManager([], []);
    const res = await propagateTaxToChildren({
      manager: manager as never,
      companyId: 8,
      parentId: 1,
      taxRateId: 5,
      taxRatePercent: 19,
    });
    expect(res).toEqual({ updatedChildren: 0, updatedPrices: 0 });
    expect(manager.update).not.toHaveBeenCalled();
  });

  it('actualiza el tax_rate_id de los hijos y re-desglosa sus precios al nuevo %', async () => {
    const { manager, updates } = buildManager(
      [{ id: '10' }, { id: '11' }],
      [
        { id: '100', sale_price: 11900 },
        { id: '101', sale_price: 999 },
      ],
    );

    const res = await propagateTaxToChildren({
      manager: manager as never,
      companyId: 8,
      parentId: 1,
      taxRateId: 3,
      taxRatePercent: 19,
    });

    expect(res).toEqual({ updatedChildren: 2, updatedPrices: 2 });

    // 1ª update: tax_rate_id de los hijos.
    expect(updates[0].set).toEqual({ tax_rate_id: '3' });

    // Updates de precios: desglose 19% con invariante base+iva=sale.
    const priceUpdates = updates.slice(1);
    const byBase = priceUpdates.map((u) => u.set);
    // 11900 → base 10000, iva 1900.
    expect(byBase).toContainEqual({ iva_percentage: 19, taxable_base: 10000, tax_amount: 1900 });
    // 999 → base 839.5 (999/1.19=839.495...→839.50), iva 159.5.
    const p999 = byBase.find((s) => (s.taxable_base as number) < 1000);
    expect(Number(((p999!.taxable_base as number) + (p999!.tax_amount as number)).toFixed(2))).toBe(
      999,
    );
  });

  it('base a Exento (taxRateId null, rate 0): precios sin IVA, base = precio', async () => {
    const { manager, updates } = buildManager([{ id: '10' }], [{ id: '100', sale_price: 5000 }]);

    await propagateTaxToChildren({
      manager: manager as never,
      companyId: 8,
      parentId: 1,
      taxRateId: null,
      taxRatePercent: 0,
    });

    expect(updates[0].set).toEqual({ tax_rate_id: null });
    expect(updates[1].set).toEqual({ iva_percentage: 0, taxable_base: 5000, tax_amount: 0 });
  });
});
