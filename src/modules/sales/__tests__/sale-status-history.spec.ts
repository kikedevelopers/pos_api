import type { EntityManager } from 'typeorm';

import { SaleCreditStatus } from '../entities/sale-credit.entity';
import { TicketType, type SaleInvoice } from '../entities/sale-invoice.entity';
import {
  SaleStatusEventType,
  SaleStatusHistory,
} from '../entities/sale-status-history.entity';
import { recordSaleStatus } from '../internal/record-sale-status.helper';
import { toSaleResponseDto } from '../dto/sale-response.dto';

/**
 * Unit tests del HISTORIAL DE ESTADOS:
 *   1. `recordSaleStatus` — el helper compartido de INSERT.
 *   2. `toSaleResponseDto` — el serializador expone `statusHistory` con el shape
 *      exacto y preservando el orden que le llega desde la action.
 *
 * Sin BD: `EntityManager` mockeado; entidades como objetos planos.
 */
describe('recordSaleStatus (helper)', () => {
  function mockManager(): { manager: EntityManager; insert: jest.Mock } {
    const insert = jest.fn().mockResolvedValue(undefined);
    const manager = { insert } as unknown as EntityManager;
    return { manager, insert };
  }

  it('inserta la fila con company/sale/eventType y castea ids a string', async () => {
    const { manager, insert } = mockManager();

    await recordSaleStatus(manager, {
      companyId: 8,
      saleInvoiceId: 123,
      eventType: SaleStatusEventType.COLLECTED,
      amount: 100.5,
      createdBy: 'Juan Pérez',
    });

    expect(insert).toHaveBeenCalledTimes(1);
    const [entity, row] = insert.mock.calls[0];
    expect(entity).toBe(SaleStatusHistory);
    expect(row).toEqual({
      company_id: '8',
      sale_invoice_id: '123',
      event_type: SaleStatusEventType.COLLECTED,
      amount: 100.5,
      created_by: 'Juan Pérez',
    });
  });

  it('deja amount/createdBy en null cuando se omiten (hitos sin monto)', async () => {
    const { manager, insert } = mockManager();

    await recordSaleStatus(manager, {
      companyId: 1,
      saleInvoiceId: 2,
      eventType: SaleStatusEventType.PAID,
    });

    const [, row] = insert.mock.calls[0];
    expect(row.amount).toBeNull();
    expect(row.created_by).toBeNull();
    expect(row.event_type).toBe(SaleStatusEventType.PAID);
  });
});

describe('toSaleResponseDto — statusHistory', () => {
  function baseSale(): SaleInvoice {
    return {
      id: '10',
      company_id: '8',
      ticket_type: TicketType.SALE,
      ticket_number: 'T-001',
      sale_number: 'V-001',
      customer_id: null,
      customer_name: 'Juan Pérez',
      subtotal: 100,
      tax_total: 0,
      total: 100,
      cost: 40,
      profit: 60,
      margin: 60,
      notes: null,
      points_awarded: 0,
      client_operation_id: null,
      created_by: 'Cajero',
      created_by_id: null,
      is_deleted: false,
      created_at: new Date('2026-05-12T14:30:00.000Z'),
      updated_at: new Date('2026-05-12T14:30:00.000Z'),
    } as unknown as SaleInvoice;
  }

  function historyRow(
    partial: Partial<SaleStatusHistory> & {
      event_type: SaleStatusEventType;
      created_at: Date;
    },
  ): SaleStatusHistory {
    return {
      id: '1',
      company_id: '8',
      sale_invoice_id: '10',
      amount: null,
      created_by: null,
      ...partial,
    } as SaleStatusHistory;
  }

  it('expone statusHistory con shape { eventType, amount, createdBy, createdAt } y preserva el orden', () => {
    const history: SaleStatusHistory[] = [
      historyRow({
        event_type: SaleStatusEventType.CREATED,
        created_by: 'Cajero',
        created_at: new Date('2026-05-12T14:30:00.000Z'),
      }),
      historyRow({
        event_type: SaleStatusEventType.COLLECTED,
        amount: 100,
        created_by: 'Cajero',
        created_at: new Date('2026-05-12T14:31:00.000Z'),
      }),
      historyRow({
        event_type: SaleStatusEventType.VOIDED,
        created_by: 'Admin',
        created_at: new Date('2026-05-12T15:00:00.000Z'),
      }),
    ];

    const dto = toSaleResponseDto(
      baseSale(),
      [],
      [],
      null,
      [],
      false,
      null,
      history,
    );

    expect(dto.statusHistory).toEqual([
      {
        eventType: SaleStatusEventType.CREATED,
        amount: null,
        createdBy: 'Cajero',
        createdAt: '2026-05-12T14:30:00.000Z',
      },
      {
        eventType: SaleStatusEventType.COLLECTED,
        amount: 100,
        createdBy: 'Cajero',
        createdAt: '2026-05-12T14:31:00.000Z',
      },
      {
        eventType: SaleStatusEventType.VOIDED,
        amount: null,
        createdBy: 'Admin',
        createdAt: '2026-05-12T15:00:00.000Z',
      },
    ]);
  });

  it('statusHistory por defecto es [] cuando no se provee (paridad de contrato)', () => {
    const dto = toSaleResponseDto(baseSale(), [], [], null);
    expect(dto.statusHistory).toEqual([]);
  });

  it('no rompe el resto del contrato del ticket (credit sigue mapeando)', () => {
    const credit = {
      id: '5',
      total_amount: 1000,
      paid_amount: 200,
      balance: 800,
      due_date: null,
      status: SaleCreditStatus.PARTIALLY_PAID,
      created_at: new Date('2026-05-12T14:30:00.000Z'),
    } as never;

    const dto = toSaleResponseDto(baseSale(), [], [], credit, [], false, null, [
      historyRow({
        event_type: SaleStatusEventType.CREDIT_OPENED,
        amount: 800,
        created_at: new Date('2026-05-12T14:30:05.000Z'),
      }),
    ]);

    expect(dto.credit?.status).toBe('PARTIAL');
    expect(dto.statusHistory).toHaveLength(1);
    expect(dto.statusHistory[0].eventType).toBe(SaleStatusEventType.CREDIT_OPENED);
    expect(dto.statusHistory[0].amount).toBe(800);
  });
});
