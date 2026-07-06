import { recordManualCostEditHistory } from '../recalculate-product-costs.helper';
import {
  ProductCostHistory,
  ProductCostHistoryDerivedFrom,
  ProductCostHistoryEvent,
} from '@/modules/product-history/entities/product-cost-history.entity';

function mockManager() {
  return { insert: jest.fn().mockResolvedValue({ identifiers: [{ id: '1' }] }) };
}
const actor = { id: 7, fullName: 'Kike Pacheco' };

describe('recordManualCostEditHistory (pos_api)', () => {
  it('inserta una fila EDIT/MANUAL con company/product, sin purchase, y change_pct', async () => {
    const m = mockManager();
    await recordManualCostEditHistory({
      manager: m as never,
      companyId: 8,
      productId: 42,
      costBefore: 100,
      costAfter: 150,
      actor,
    });

    expect(m.insert).toHaveBeenCalledTimes(1);
    const [entity, row] = m.insert.mock.calls[0];
    expect(entity).toBe(ProductCostHistory);
    expect(row).toMatchObject({
      company_id: '8',
      product_id: '42',
      purchase_id: null,
      event_type: ProductCostHistoryEvent.EDIT,
      derived_from: ProductCostHistoryDerivedFrom.MANUAL,
      cost_before: 100,
      cost_after: 150,
      change_pct: 50,
      created_by: 'Kike Pacheco',
      created_by_id: '7',
    });
  });

  it('es no-op si el costo no cambia (a 2 decimales)', async () => {
    const m = mockManager();
    await recordManualCostEditHistory({
      manager: m as never,
      companyId: 8,
      productId: 42,
      costBefore: 100,
      costAfter: 100.001,
      actor,
    });
    expect(m.insert).not.toHaveBeenCalled();
  });

  it('change_pct = 0 si el costo previo era 0', async () => {
    const m = mockManager();
    await recordManualCostEditHistory({
      manager: m as never,
      companyId: 8,
      productId: 42,
      costBefore: 0,
      costAfter: 50,
      actor,
    });
    const [, row] = m.insert.mock.calls[0];
    expect(row.change_pct).toBe(0);
  });
});
