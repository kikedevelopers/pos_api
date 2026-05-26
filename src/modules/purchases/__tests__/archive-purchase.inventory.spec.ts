import type { DataSource, EntityManager } from 'typeorm';

import type { FinancialMovementsService } from '@/modules/financial-movements/financial-movements.service';
import { adjustInventory } from '@/modules/products/internal/adjust-inventory.helper';

import { ArchivePurchaseAction } from '../actions/archive-purchase.action';
import type { Purchase } from '../entities/purchase.entity';
import { PurchaseStatus } from '../entities/purchase.entity';

jest.mock('@/modules/products/internal/adjust-inventory.helper', () => ({
  adjustInventory: jest.fn().mockResolvedValue(undefined),
}));

const adjustInventoryMock = jest.mocked(adjustInventory);

/**
 * Blinda la reversión de stock al archivar una compra recibida.
 *
 * Regresión: `revertStock` pasaba `unit_qty` a `adjustInventory` SIN
 * `packaging_value`, por lo que el helper —pensado para ventas— re-multiplicaba
 * por el `packaging_value` del producto y restaba de más en productos con
 * empaque. El fix pasa `packaging_value: 1` (en compras `unit_qty` ya está en
 * unidad mínima) para que el archivado revierta exactamente lo que sumó la
 * recepción.
 */
describe('ArchivePurchaseAction.revertStock — packaging_value:1', () => {
  type RevertStock = (
    manager: EntityManager,
    companyId: number,
    purchase: Purchase,
    forceStockAdjustment: boolean,
    actor: { id: number; fullName: string; type: string | null },
  ) => Promise<void>;

  let revertStock: RevertStock;
  const actor = { id: 7, fullName: 'Kike', type: 'owner' };

  beforeEach(() => {
    adjustInventoryMock.mockClear();
    const action = new ArchivePurchaseAction(
      {} as unknown as DataSource,
      {} as unknown as FinancialMovementsService,
    );
    revertStock = (action as unknown as { revertStock: RevertStock }).revertStock.bind(action);
  });

  function buildPurchase(): Purchase {
    return {
      id: '100',
      purchase_number: 'PUR-005',
      supplier_id: '1',
      status: PurchaseStatus.RECEIVED,
    } as Purchase;
  }

  function managerReturning(lines: Array<{ product_id: string; unit_qty: number }>): EntityManager {
    return { find: jest.fn().mockResolvedValue(lines) } as unknown as EntityManager;
  }

  it('agrega unit_qty por producto y pasa packaging_value:1 con DEDUCT', async () => {
    // Dos líneas del mismo producto: 12000 + 8000 = 20000 (unidad mínima).
    const manager = managerReturning([
      { product_id: '10', unit_qty: 12000 },
      { product_id: '10', unit_qty: 8000 },
    ]);

    await revertStock(manager, 42, buildPurchase(), false, actor);

    expect(adjustInventoryMock).toHaveBeenCalledTimes(1);
    const call = adjustInventoryMock.mock.calls[0];
    expect(call?.[1]).toBe(42);
    expect(call?.[3]).toBe('DEDUCT');
    // Cantidad cruda (sin multiplicar) + packaging_value:1.
    expect(call?.[2]).toEqual([{ item_id: 10, quantity: 20000, packaging_value: 1 }]);
    expect(call?.[4]).toMatchObject({
      reason: 'PURCHASE_ARCHIVE',
      referenceType: 'purchase',
      referenceId: 100,
      referenceCode: 'PUR-005',
      overrideStock: false,
    });
  });

  it('propaga overrideStock=true cuando se fuerza el ajuste', async () => {
    const manager = managerReturning([{ product_id: '10', unit_qty: 20000 }]);

    await revertStock(manager, 42, buildPurchase(), true, actor);

    const call = adjustInventoryMock.mock.calls[0];
    expect(call?.[2]).toEqual([{ item_id: 10, quantity: 20000, packaging_value: 1 }]);
    expect(call?.[4]).toMatchObject({ overrideStock: true });
  });

  it('no llama adjustInventory cuando no hay líneas con cantidad positiva', async () => {
    const manager = managerReturning([{ product_id: '10', unit_qty: 0 }]);

    await revertStock(manager, 42, buildPurchase(), false, actor);

    expect(adjustInventoryMock).not.toHaveBeenCalled();
  });
});
