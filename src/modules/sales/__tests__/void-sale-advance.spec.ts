import { Test, type TestingModule } from '@nestjs/testing';
import { DataSource } from 'typeorm';

import { FinancialMovementsService } from '@/modules/financial-movements/financial-movements.service';
import { IncrementTicketNumberAction } from '@/modules/ticket-settings/actions/increment-ticket-number.action';

// Aislamos la anulación: el lock/lookup de la venta, el consolidado, el ajuste
// de inventario, los puntos y el historial se mockean para observar solo la
// rama ADVANCE (restauración de advance_balance).
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
import { VoidSaleAction } from '../actions/void-sale.action';

const findSaleMock = findSaleInCompany as jest.MockedFunction<typeof findSaleInCompany>;
const getConsolidatedMock = getConsolidatedInvoice as jest.MockedFunction<
  typeof getConsolidatedInvoice
>;

/**
 * Anular una venta pagada con ADVANCE debe devolver el neto al
 * `advance_balance` del cliente (sin mover caja/banco). Consolidado sin líneas
 * → NC total = 0, sin inventario, sin reversa CASH/TRANSFER.
 */
describe('VoidSaleAction (restauración ADVANCE)', () => {
  let action: VoidSaleAction;
  let updates: Array<{
    entity: string;
    where: Record<string, unknown>;
    patch: Record<string, unknown>;
  }>;
  let recordSpy: jest.Mock;
  let customerAdvanceBalance: number;
  let salePayments: Array<Record<string, unknown>>;

  function buildManagerMock() {
    return {
      findOne: jest.fn(
        (entity: { name?: string } | string, options: { where: Record<string, unknown> }) => {
          const name = typeof entity === 'string' ? entity : (entity.name ?? 'Unknown');
          const where = options.where;
          if (name === 'CreditNote') {
            // No hay FULL_VOID previa (idempotencia OK).
            return Promise.resolve(null);
          }
          if (name === 'Customer') {
            return Promise.resolve({
              id: String(where.id),
              company_id: String(where.company_id),
              advance_balance: customerAdvanceBalance,
            });
          }
          return Promise.resolve(null);
        },
      ),
      find: jest.fn((entity: { name?: string } | string) => {
        const name = typeof entity === 'string' ? entity : (entity.name ?? 'Unknown');
        if (name === 'SalePayment') {
          return Promise.resolve(salePayments);
        }
        return Promise.resolve([]);
      }),
      insert: jest.fn().mockResolvedValue({ raw: [], identifiers: [], generatedMaps: [] }),
      create: jest.fn((_entity: unknown, input: Record<string, unknown>) => input),
      save: jest.fn((_entity: unknown, payload: Record<string, unknown>) =>
        Promise.resolve({ ...payload, id: '777' }),
      ),
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
    customerAdvanceBalance = 200;
    salePayments = [
      {
        id: '900',
        sale_invoice_id: '142',
        company_id: '42',
        payment_method: 'ADVANCE',
        account_type: 'customer_advance',
        account_id: '55',
        amount: 150,
        change_amount: 0,
        is_voided: false,
      },
    ];

    findSaleMock.mockReset();
    findSaleMock.mockResolvedValue({
      id: '142',
      company_id: '42',
      customer_id: '55',
      ticket_type: 'SALE',
      is_deleted: false,
      note_number: null,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);

    getConsolidatedMock.mockReset();
    // Consolidado sin líneas → NC total 0, sin inventario.
    getConsolidatedMock.mockResolvedValue({ total: 0, lines: [] } as never);

    recordSpy = jest.fn().mockResolvedValue(undefined);

    const transaction = jest.fn(
      async <T>(_isolation: unknown, cb: (m: ReturnType<typeof buildManagerMock>) => Promise<T>) =>
        cb(buildManagerMock()),
    );
    const dataSourceMock = { transaction };
    const incrementMock = {
      execute: jest.fn().mockResolvedValue({ number: 1, formatted: 'NC-001' }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        VoidSaleAction,
        { provide: DataSource, useValue: dataSourceMock },
        { provide: IncrementTicketNumberAction, useValue: incrementMock },
        { provide: FinancialMovementsService, useValue: { record: recordSpy } },
      ],
    }).compile();

    action = module.get(VoidSaleAction);
  });

  const actor = { id: 7, fullName: 'Kike Pacheco', type: 'owner' };

  it('anular venta pagada con ADVANCE restaura advance_balance (200 + 150 = 350) y NO mueve caja/banco', async () => {
    const result = await action.execute(142, 42, actor, 'anulación');

    expect(result.creditNoteId).toBe(777);

    // advance_balance restaurado.
    const advanceUpdate = updates.find(
      (u) => u.entity === 'Customer' && u.patch.advance_balance !== undefined,
    );
    expect(advanceUpdate?.patch.advance_balance).toBe(350);

    // NO mueve caja/banco ni emite FinancialMovement (el anticipo nunca movió caja).
    expect(updates.find((u) => u.entity === 'CashRegister')).toBeUndefined();
    expect(updates.find((u) => u.entity === 'Bank')).toBeUndefined();
    expect(recordSpy).not.toHaveBeenCalled();
  });
});
