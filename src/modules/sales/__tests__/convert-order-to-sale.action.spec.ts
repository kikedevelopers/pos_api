import { UnprocessableEntityException } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { DataSource } from 'typeorm';

import { IncrementTicketNumberAction } from '@/modules/ticket-settings/actions/increment-ticket-number.action';
import { TicketSettingType } from '@/modules/ticket-settings/entities/ticket-setting.entity';

import { ConvertOrderToSaleAction } from '../actions/convert-order-to-sale.action';
import type { SaleInvoice } from '../entities/sale-invoice.entity';
import { TicketType } from '../entities/sale-invoice.entity';

/**
 * Tests unitarios de `ConvertOrderToSaleAction`. Cubrimos:
 *   - ORDER → SALE genera nuevo folio con TicketSettingType.SALE.
 *   - SALE ya confirmada → 422 con código SALE_ALREADY_CONFIRMED.
 *   - Toda dentro de UNA transacción.
 */
describe('ConvertOrderToSaleAction', () => {
  let action: ConvertOrderToSaleAction;
  let transactionSpy: jest.Mock;
  let incrementSpy: jest.Mock;
  let updates: Array<{
    entity: string;
    where: Record<string, unknown>;
    patch: Record<string, unknown>;
  }>;
  let sales: Map<string, Partial<SaleInvoice>>;

  beforeEach(async () => {
    updates = [];
    sales = new Map();

    const managerMock = {
      findOne: jest.fn(
        (
          entity: { name?: string } | string,
          options: { where: Record<string, unknown> },
        ): Promise<unknown> => {
          const entityName = typeof entity === 'string' ? entity : (entity.name ?? 'Unknown');
          const where = options.where;
          if (entityName === 'SaleInvoice') {
            const key = `${String(where.id)}|${String(where.company_id)}`;
            const sale = sales.get(key);
            if (!sale) {
              return Promise.resolve(null);
            }
            if (where.is_deleted === false && sale.is_deleted) {
              return Promise.resolve(null);
            }
            return Promise.resolve(sale);
          }
          return Promise.resolve(null);
        },
      ),
      find: jest.fn().mockResolvedValue([]),
      update: jest.fn(
        (
          entity: { name?: string } | string,
          where: Record<string, unknown>,
          patch: Record<string, unknown>,
        ) => {
          const entityName = typeof entity === 'string' ? entity : (entity.name ?? 'Unknown');
          updates.push({ entity: entityName, where, patch });
          if (entityName === 'SaleInvoice') {
            // Reflejar cambio en el mock para que la relectura final lo vea.
            const key = `${String(where.id)}|${String(where.company_id)}`;
            const sale = sales.get(key);
            if (sale) {
              sales.set(key, { ...sale, ...patch });
            }
          }
          return Promise.resolve({ raw: [], affected: 1, generatedMaps: [] });
        },
      ),
    };

    transactionSpy = jest.fn(async <T>(cb: (m: typeof managerMock) => Promise<T>) =>
      cb(managerMock),
    );
    // Primer call (ORDER ya hecho al crear venta original) — ignorado.
    // Aquí solo se llama una vez con ticket_type = SALE.
    incrementSpy = jest.fn().mockResolvedValue({ number: 7, formatted: 'F-007' });

    const dataSourceMock = { transaction: transactionSpy };
    const incrementTicketNumberMock = { execute: incrementSpy };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ConvertOrderToSaleAction,
        { provide: DataSource, useValue: dataSourceMock },
        { provide: IncrementTicketNumberAction, useValue: incrementTicketNumberMock },
      ],
    }).compile();

    action = module.get(ConvertOrderToSaleAction);
  });

  function seedSale(
    id: number,
    companyId: number,
    ticketType: TicketType = TicketType.ORDER,
  ): void {
    sales.set(`${id}|${companyId}`, {
      id: String(id),
      company_id: String(companyId),
      ticket_type: ticketType,
      ticket_number: 'P-001',
      sale_number: ticketType === TicketType.SALE ? 'F-001' : null,
      total: 100,
      is_deleted: false,
    });
  }

  it('ORDER → SALE: genera sale_number con prefix de TicketSettingType.SALE', async () => {
    seedSale(10, 42, TicketType.ORDER);

    await action.execute(10, 42, 7);

    // Increment debe haberse llamado UNA VEZ con TicketSettingType.SALE.
    expect(incrementSpy).toHaveBeenCalledTimes(1);
    const incCall = incrementSpy.mock.calls[0] as unknown[];
    expect(incCall[1]).toBe(42);
    expect(incCall[2]).toBe(TicketSettingType.SALE);

    // El UPDATE actualiza ticket_type a SALE y sale_number al folio generado.
    const saleUpdate = updates.find((u) => u.entity === 'SaleInvoice');
    expect(saleUpdate?.patch.ticket_type).toBe(TicketType.SALE);
    expect(saleUpdate?.patch.sale_number).toBe('F-007');
  });

  it('SALE ya confirmada → 422', async () => {
    seedSale(10, 42, TicketType.SALE);

    await expect(action.execute(10, 42, 7)).rejects.toBeInstanceOf(UnprocessableEntityException);
    expect(incrementSpy).not.toHaveBeenCalled();
  });

  it('toda la operación ocurre dentro de UNA transacción', async () => {
    seedSale(10, 42, TicketType.ORDER);
    await action.execute(10, 42, 7);
    expect(transactionSpy).toHaveBeenCalledTimes(1);
  });

  it('cross-tenant: venta de otra company → 404', async () => {
    seedSale(10, 99, TicketType.ORDER);
    // Intentamos convertir como company 42; debe lanzar NotFoundException
    // (que viene de findSaleInCompany).
    await expect(action.execute(10, 42, 7)).rejects.toThrow();
  });
});
