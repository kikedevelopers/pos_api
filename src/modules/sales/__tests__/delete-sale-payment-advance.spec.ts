import { Test, type TestingModule } from '@nestjs/testing';
import { DataSource } from 'typeorm';

import { FinancialMovementsService } from '@/modules/financial-movements/financial-movements.service';

// El action delega el lock/lookup de la venta y el recompute del settlement en
// helpers de módulo. Los interceptamos para aislar la rama ADVANCE.
jest.mock('../internal/recompute-sale-settlement', () => ({
  loadSaleForSettlement: jest.fn(),
  recomputeSaleSettlement: jest.fn(),
}));

import {
  loadSaleForSettlement,
  recomputeSaleSettlement,
} from '../internal/recompute-sale-settlement';
import { DeleteSalePaymentAction } from '../actions/delete-sale-payment.action';

const loadSaleMock = loadSaleForSettlement as jest.MockedFunction<typeof loadSaleForSettlement>;
const recomputeMock = recomputeSaleSettlement as jest.MockedFunction<
  typeof recomputeSaleSettlement
>;

/**
 * Reverso de un pago ADVANCE: debe RESTAURAR `advance_balance` del cliente
 * (sin mover caja/banco). `account_id` del pago customer_advance es el
 * `customers.id` (lo fijó `applyAdvance`), así que la restauración es
 * self-contained.
 */
describe('DeleteSalePaymentAction (reverso ADVANCE)', () => {
  let action: DeleteSalePaymentAction;
  let updates: Array<{
    entity: string;
    where: Record<string, unknown>;
    patch: Record<string, unknown>;
  }>;
  let recordSpy: jest.Mock;
  let customerAdvanceBalance: number;

  function buildManagerMock() {
    return {
      findOne: jest.fn(
        (entity: { name?: string } | string, options: { where: Record<string, unknown> }) => {
          const name = typeof entity === 'string' ? entity : (entity.name ?? 'Unknown');
          const where = options.where;
          if (name === 'SalePayment') {
            // Pago ADVANCE vivo (no reversado). account_id = customer_id (55).
            return Promise.resolve({
              id: String(where.id),
              sale_invoice_id: String(where.sale_invoice_id),
              company_id: String(where.company_id),
              payment_method: 'ADVANCE',
              account_type: 'customer_advance',
              account_id: '55',
              amount: 150,
              change_amount: 0,
              is_voided: false,
            });
          }
          if (name === 'SaleCredit') {
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
      save: jest.fn((_entity: unknown, payload: Record<string, unknown>) =>
        Promise.resolve(payload),
      ),
      create: jest.fn((_entity: unknown, input: Record<string, unknown>) => input),
    };
  }

  beforeEach(async () => {
    updates = [];
    customerAdvanceBalance = 350;

    loadSaleMock.mockReset();
    loadSaleMock.mockResolvedValue({
      id: '142',
      company_id: '42',
      customer_id: '55',
      sale_number: 'SALE-001',
      ticket_number: 'ORD-001',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);

    recomputeMock.mockReset();
    recomputeMock.mockResolvedValue({ paid: 0, balance: 0, status: 'PAID' } as never);

    recordSpy = jest.fn().mockResolvedValue(undefined);

    const transaction = jest.fn(
      async <T>(_isolation: unknown, cb: (m: ReturnType<typeof buildManagerMock>) => Promise<T>) =>
        cb(buildManagerMock()),
    );
    const dataSourceMock = { transaction };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DeleteSalePaymentAction,
        { provide: DataSource, useValue: dataSourceMock },
        { provide: FinancialMovementsService, useValue: { record: recordSpy } },
      ],
    }).compile();

    action = module.get(DeleteSalePaymentAction);
  });

  const actor = { id: 7, fullName: 'Kike Pacheco', type: 'owner' };

  it('reversar un pago ADVANCE restaura advance_balance (350 + 150 = 500) y NO mueve caja/banco', async () => {
    const result = await action.execute(142, 900, 42, actor, 'test', null);

    expect(result.success).toBe(true);
    expect(result.reversed_amount).toBe(150);

    // advance_balance restaurado.
    const advanceUpdate = updates.find(
      (u) => u.entity === 'Customer' && u.patch.advance_balance !== undefined,
    );
    expect(advanceUpdate?.patch.advance_balance).toBe(500);

    // Soft-delete del pago.
    const paymentUpdate = updates.find(
      (u) => u.entity === 'SalePayment' && u.patch.is_voided === true,
    );
    expect(paymentUpdate).toBeDefined();

    // NO mueve caja/banco/wallet ni emite FinancialMovement.
    expect(updates.find((u) => u.entity === 'CashRegister')).toBeUndefined();
    expect(updates.find((u) => u.entity === 'Bank')).toBeUndefined();
    expect(updates.find((u) => u.entity === 'Wallet')).toBeUndefined();
    expect(recordSpy).not.toHaveBeenCalled();
  });
});
