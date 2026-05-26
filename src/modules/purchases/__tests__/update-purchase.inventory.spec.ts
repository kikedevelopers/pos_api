import type { DataSource, EntityManager } from 'typeorm';

import type { FinancialMovementsService } from '@/modules/financial-movements/financial-movements.service';
import { adjustInventory } from '@/modules/products/internal/adjust-inventory.helper';

import { UpdatePurchaseAction } from '../actions/update-purchase.action';
import type { PurchaseLine } from '../entities/purchase-line.entity';

jest.mock('@/modules/products/internal/adjust-inventory.helper', () => ({
  adjustInventory: jest.fn().mockResolvedValue(undefined),
}));

const adjustInventoryMock = jest.mocked(adjustInventory);

/**
 * Blinda el ajuste diferencial de stock al editar una compra RECEIVED.
 *
 * Regresión: `applyInventoryDelta` componía el delta de `unit_qty` y lo pasaba
 * a `adjustInventory` SIN `packaging_value`, por lo que el helper re-multiplicaba
 * por el packaging del producto y ajustaba de más. El fix pasa
 * `packaging_value: 1` (en compras `unit_qty` ya está en unidad mínima).
 */
describe('UpdatePurchaseAction.applyInventoryDelta — packaging_value:1', () => {
  type LineData = { product_id: string; unit_qty: number };
  type ApplyInventoryDelta = (
    manager: EntityManager,
    companyId: number,
    oldLines: PurchaseLine[],
    newLinesData: LineData[],
    purchaseId: number,
    purchaseNumber: string,
    actor: { id: number; fullName: string },
  ) => Promise<void>;

  let applyInventoryDelta: ApplyInventoryDelta;
  const actor = { id: 7, fullName: 'Kike' };

  beforeEach(() => {
    adjustInventoryMock.mockClear();
    const action = new UpdatePurchaseAction(
      {} as unknown as DataSource,
      {} as unknown as FinancialMovementsService,
    );
    applyInventoryDelta = (
      action as unknown as { applyInventoryDelta: ApplyInventoryDelta }
    ).applyInventoryDelta.bind(action);
  });

  function call(oldLines: LineData[], newLinesData: LineData[]): Promise<void> {
    return applyInventoryDelta(
      {} as unknown as EntityManager,
      42,
      oldLines as PurchaseLine[],
      newLinesData,
      100,
      'PUR-005',
      actor,
    );
  }

  it('reducir la cantidad emite un DEDUCT con la diferencia cruda y packaging_value:1', async () => {
    // 30000 → 20000: delta neto = -10000 (DEDUCT 10000).
    await call([{ product_id: '10', unit_qty: 30000 }], [{ product_id: '10', unit_qty: 20000 }]);

    expect(adjustInventoryMock).toHaveBeenCalledTimes(1);
    const call0 = adjustInventoryMock.mock.calls[0];
    expect(call0?.[1]).toBe(42);
    expect(call0?.[3]).toBe('DEDUCT');
    expect(call0?.[2]).toEqual([{ item_id: 10, quantity: 10000, packaging_value: 1 }]);
    expect(call0?.[4]).toMatchObject({
      reason: 'PURCHASE_EDIT',
      referenceId: 100,
      referenceCode: 'PUR-005',
    });
  });

  it('aumentar la cantidad emite un RETURN con la diferencia cruda y packaging_value:1', async () => {
    // 20000 → 30000: delta neto = +10000 (RETURN 10000).
    await call([{ product_id: '10', unit_qty: 20000 }], [{ product_id: '10', unit_qty: 30000 }]);

    expect(adjustInventoryMock).toHaveBeenCalledTimes(1);
    const call0 = adjustInventoryMock.mock.calls[0];
    expect(call0?.[3]).toBe('RETURN');
    expect(call0?.[2]).toEqual([{ item_id: 10, quantity: 10000, packaging_value: 1 }]);
  });

  it('sin cambio neto de cantidad no llama adjustInventory', async () => {
    await call([{ product_id: '10', unit_qty: 20000 }], [{ product_id: '10', unit_qty: 20000 }]);
    expect(adjustInventoryMock).not.toHaveBeenCalled();
  });

  it('mezcla de productos: DEDUCT para el que baja y RETURN para el que sube', async () => {
    await call(
      [
        { product_id: '10', unit_qty: 30000 },
        { product_id: '20', unit_qty: 5000 },
      ],
      [
        { product_id: '10', unit_qty: 20000 }, // -10000 → DEDUCT
        { product_id: '20', unit_qty: 9000 }, // +4000 → RETURN
      ],
    );

    expect(adjustInventoryMock).toHaveBeenCalledTimes(2);
    const ret = adjustInventoryMock.mock.calls.find((c) => c[3] === 'RETURN');
    const deduct = adjustInventoryMock.mock.calls.find((c) => c[3] === 'DEDUCT');
    expect(ret?.[2]).toEqual([{ item_id: 20, quantity: 4000, packaging_value: 1 }]);
    expect(deduct?.[2]).toEqual([{ item_id: 10, quantity: 10000, packaging_value: 1 }]);
  });
});
