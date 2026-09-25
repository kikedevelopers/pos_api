import { Test, type TestingModule } from '@nestjs/testing';
import { DataSource } from 'typeorm';

import { FinancialMovementsService } from '@/modules/financial-movements/financial-movements.service';
import { IncrementTicketNumberAction } from '@/modules/ticket-settings/actions/increment-ticket-number.action';

// Aislamos la anulación del préstamo (rama LOAN): observamos que devuelve la
// mercancía (adjustInventory RETURN) y hace soft-delete, SIN nota crédito ni
// reversa de caja (un préstamo nunca movió dinero).
jest.mock('../internal/sale-lookups', () => ({
  findSaleInCompany: jest.fn(),
}));
jest.mock('../internal/consolidate-invoice.helper', () => ({
  getConsolidatedInvoice: jest.fn(),
}));
jest.mock('../internal/customer-points.helper', () => ({
  recomputeSalePoints: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../internal/record-sale-status.helper', () => ({
  recordSaleStatus: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('@/modules/products/internal/adjust-inventory.helper', () => ({
  adjustInventory: jest.fn().mockResolvedValue(undefined),
}));

import { findSaleInCompany } from '../internal/sale-lookups';
import { getConsolidatedInvoice } from '../internal/consolidate-invoice.helper';
import { recordSaleStatus } from '../internal/record-sale-status.helper';
import { adjustInventory } from '@/modules/products/internal/adjust-inventory.helper';
import { VoidSaleAction } from '../actions/void-sale.action';

const findSaleMock = findSaleInCompany as jest.MockedFunction<typeof findSaleInCompany>;
const getConsolidatedMock = getConsolidatedInvoice as jest.MockedFunction<
  typeof getConsolidatedInvoice
>;
const adjustInventoryMock = adjustInventory as jest.MockedFunction<typeof adjustInventory>;
const recordSaleStatusMock = recordSaleStatus as jest.MockedFunction<typeof recordSaleStatus>;

describe('VoidSaleAction (rama LOAN — préstamo a tercero)', () => {
  let action: VoidSaleAction;
  let updates: Array<{ entity: string; where: Record<string, unknown>; patch: Record<string, unknown> }>;
  let saved: Array<{ entity: string }>;
  let saleLines: Array<Record<string, unknown>>;

  function buildManagerMock() {
    return {
      findOne: jest.fn().mockResolvedValue(null),
      find: jest.fn((entity: { name?: string } | string) => {
        const name = typeof entity === 'string' ? entity : (entity.name ?? 'Unknown');
        if (name === 'SaleInvoiceLine') return Promise.resolve(saleLines);
        return Promise.resolve([]);
      }),
      insert: jest.fn().mockResolvedValue({ raw: [], identifiers: [], generatedMaps: [] }),
      create: jest.fn((_entity: unknown, input: Record<string, unknown>) => input),
      save: jest.fn((entity: { name?: string } | string, payload: Record<string, unknown>) => {
        const name = typeof entity === 'string' ? entity : (entity.name ?? 'Unknown');
        saved.push({ entity: name });
        return Promise.resolve({ ...payload, id: '777' });
      }),
      update: jest.fn(
        (
          entity: { name?: string } | string,
          where: Record<string, unknown>,
          patch: Record<string, unknown>,
        ) => {
          const name = typeof entity === 'string' ? entity : (entity.name ?? 'Unknown');
          updates.push({ entity: name, where, patch });
          return Promise.resolve({ raw: [], affected: 1, generatedMaps: [] });
        },
      ),
    };
  }

  beforeEach(async () => {
    updates = [];
    saved = [];
    saleLines = [
      { product_id: '10', quantity: 2, packaging_value: 1, combo_recipe: null },
      { product_id: '11', quantity: 1, packaging_value: 6, combo_recipe: null },
    ];

    findSaleMock.mockReset();
    findSaleMock.mockResolvedValue({
      id: '300',
      company_id: '42',
      customer_id: '55',
      ticket_type: 'LOAN',
      ticket_number: 'PED-8270',
      is_deleted: false,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);

    getConsolidatedMock.mockReset();
    adjustInventoryMock.mockClear();
    recordSaleStatusMock.mockClear();

    const transaction = jest.fn(
      async <T>(_iso: unknown, cb: (m: ReturnType<typeof buildManagerMock>) => Promise<T>) =>
        cb(buildManagerMock()),
    );

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        VoidSaleAction,
        { provide: DataSource, useValue: { transaction } },
        { provide: IncrementTicketNumberAction, useValue: { execute: jest.fn() } },
        { provide: FinancialMovementsService, useValue: { record: jest.fn() } },
      ],
    }).compile();

    action = module.get(VoidSaleAction);
  });

  const actor = { id: 7, fullName: 'Kike Pacheco', type: 'owner' };

  it('devuelve la mercancía al inventario con RETURN (simétrico al DEDUCT del préstamo)', async () => {
    await action.execute(300, 42, actor, 'anulación');

    expect(adjustInventoryMock).toHaveBeenCalledTimes(1);
    const [, companyIdArg, linesArg, direction] = adjustInventoryMock.mock.calls[0];
    expect(companyIdArg).toBe(42);
    expect(direction).toBe('RETURN');
    expect(linesArg).toEqual([
      { item_id: 10, quantity: 2, packaging_value: 1, combo_recipe: null },
      { item_id: 11, quantity: 1, packaging_value: 6, combo_recipe: null },
    ]);
  });

  it('hace soft-delete de la factura y registra el evento VOIDED', async () => {
    const result = await action.execute(300, 42, actor);

    const softDelete = updates.find(
      (u) => u.entity === 'SaleInvoice' && u.patch.is_deleted === true,
    );
    expect(softDelete).toBeDefined();
    expect(recordSaleStatusMock).toHaveBeenCalledTimes(1);
    expect(result.message).toBe('Préstamo anulado exitosamente');
  });

  it('NO genera nota crédito ni reversa de caja (un préstamo no movió dinero)', async () => {
    const result = await action.execute(300, 42, actor);

    expect(result.creditNoteId).toBeNull();
    expect(result.creditNoteNumber).toBeNull();
    // No se guarda ninguna entidad (la NC se crea con save; aquí no debe ocurrir).
    expect(saved).toHaveLength(0);
    // No se toca caja ni banco.
    expect(updates.find((u) => u.entity === 'CashRegister')).toBeUndefined();
    expect(updates.find((u) => u.entity === 'Bank')).toBeUndefined();
  });

  it('un préstamo sin líneas no llama a adjustInventory pero igual se anula', async () => {
    saleLines = [];
    const result = await action.execute(300, 42, actor);
    expect(adjustInventoryMock).not.toHaveBeenCalled();
    expect(result.message).toBe('Préstamo anulado exitosamente');
  });
});
