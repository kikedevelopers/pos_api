import { BadRequestException } from '@nestjs/common';
import { type FindOperator, In, type Repository } from 'typeorm';

import { parseDateRange, todayUtc } from '@/modules/dashboard/internal/date-range';
import { SaleInvoiceLine } from '@/modules/sales/entities/sale-invoice-line.entity';
import { SaleInvoice, TicketType } from '@/modules/sales/entities/sale-invoice.entity';

import { FindActiveOrdersAction } from '../actions/find-active-orders.action';

/** Extrae los límites [inicio, fin] de un `Between(...)` de TypeORM. */
function betweenBounds(op: unknown): [Date, Date] {
  const operator = op as FindOperator<Date>;
  return (operator as unknown as { value: [Date, Date] }).value;
}

const COMPANY_ID = 42;

function order(over: Partial<Record<string, unknown>> = {}): SaleInvoice {
  return {
    id: '1',
    company_id: String(COMPANY_ID),
    ticket_type: TicketType.ORDER,
    ticket_number: 'PED-1',
    is_deleted: false,
    customer_name: 'Juan Pérez',
    table_name: null,
    salon_name: null,
    created_at: new Date('2026-10-06T10:00:00.000Z'),
    ...over,
  } as unknown as SaleInvoice;
}

function line(over: Partial<Record<string, unknown>> = {}): SaleInvoiceLine {
  return {
    id: '1',
    sale_invoice_id: '1',
    company_id: String(COMPANY_ID),
    description: 'Hamburguesa',
    quantity: 1,
    note: null,
    ...over,
  } as unknown as SaleInvoiceLine;
}

describe('FindActiveOrdersAction', () => {
  let action: FindActiveOrdersAction;
  let salesFind: jest.Mock;
  let linesFind: jest.Mock;
  let orders: SaleInvoice[];
  let lines: SaleInvoiceLine[];

  beforeEach(() => {
    orders = [];
    lines = [];
    salesFind = jest.fn(() => Promise.resolve(orders));
    linesFind = jest.fn(() => Promise.resolve(lines));

    const salesRepo = { find: salesFind } as unknown as Repository<SaleInvoice>;
    const linesRepo = { find: linesFind } as unknown as Repository<SaleInvoiceLine>;
    action = new FindActiveOrdersAction(salesRepo, linesRepo);
  });

  it('filtra solo pedidos ORDER activos de la company y en orden FIFO (created_at ASC)', async () => {
    orders = [order()];
    await action.execute(COMPANY_ID);

    expect(salesFind).toHaveBeenCalledTimes(1);
    const arg = salesFind.mock.calls[0][0] as {
      where: Record<string, unknown>;
      order: Record<string, unknown>;
    };
    expect(arg.where).toMatchObject({
      company_id: String(COMPANY_ID),
      ticket_type: TicketType.ORDER,
      is_deleted: false,
    });
    expect(arg.order).toMatchObject({ created_at: 'ASC' });
  });

  it('sin fecha: filtra por el día ACTUAL (hora Colombia) vía created_at', async () => {
    orders = [order()];
    await action.execute(COMPANY_ID);

    const arg = salesFind.mock.calls[0][0] as { where: Record<string, unknown> };
    const expected = parseDateRange(todayUtc(), todayUtc());
    expect(betweenBounds(arg.where.created_at)).toEqual([expected.dateStart, expected.dateEnd]);
  });

  it('con fecha: filtra por ese día colombiano [00:00, 23:59:59.999] → UTC', async () => {
    orders = [order()];
    await action.execute(COMPANY_ID, '2026-10-06');

    const arg = salesFind.mock.calls[0][0] as { where: Record<string, unknown> };
    const expected = parseDateRange('2026-10-06', '2026-10-06');
    // Colombia es UTC-5: el día arranca a las 05:00Z y termina 04:59:59.999Z del día siguiente.
    expect(expected.dateStart.toISOString()).toBe('2026-10-06T05:00:00.000Z');
    expect(expected.dateEnd.toISOString()).toBe('2026-10-07T04:59:59.999Z');
    expect(betweenBounds(arg.where.created_at)).toEqual([expected.dateStart, expected.dateEnd]);
  });

  it('fecha con formato inválido: lanza BadRequestException y NO consulta', async () => {
    await expect(action.execute(COMPANY_ID, '07-10-2026')).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(salesFind).not.toHaveBeenCalled();
  });

  it('mapea el pedido: ticketNumber, fecha ISO, mesa/salón y detalle de productos', async () => {
    orders = [
      order({
        id: '10',
        ticket_number: 'PED-10',
        table_name: 'Mesa 5',
        salon_name: 'Sur A',
        created_at: new Date('2026-10-06T12:00:00.000Z'),
      }),
    ];
    lines = [
      line({ id: '1', sale_invoice_id: '10', description: 'Pizza', quantity: 2, note: 'Sin queso' }),
      line({ id: '2', sale_invoice_id: '10', description: 'Gaseosa', quantity: 3, note: null }),
    ];

    const result = await action.execute(COMPANY_ID);

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      id: 10,
      ticketNumber: 'PED-10',
      createdAt: '2026-10-06T12:00:00.000Z',
      tableName: 'Mesa 5',
      salonName: 'Sur A',
      customerName: 'Juan Pérez',
      lines: [
        { name: 'Pizza', quantity: 2, note: 'Sin queso' },
        { name: 'Gaseosa', quantity: 3, note: null },
      ],
    });
  });

  it('agrupa las líneas por pedido (batch, sin cruzar pedidos)', async () => {
    orders = [
      order({ id: '1', ticket_number: 'PED-1', created_at: new Date('2026-10-06T10:00:00.000Z') }),
      order({ id: '2', ticket_number: 'PED-2', created_at: new Date('2026-10-06T11:00:00.000Z') }),
    ];
    lines = [
      line({ id: '1', sale_invoice_id: '1', description: 'A' }),
      line({ id: '2', sale_invoice_id: '2', description: 'B' }),
      line({ id: '3', sale_invoice_id: '1', description: 'C' }),
    ];

    const result = await action.execute(COMPANY_ID);

    expect(result.map((c) => c.id)).toEqual([1, 2]); // FIFO preservado
    expect(result[0].lines.map((l) => l.name)).toEqual(['A', 'C']);
    expect(result[1].lines.map((l) => l.name)).toEqual(['B']);
    // Las líneas se piden en UN batch por los ids de los pedidos activos.
    const lineArg = linesFind.mock.calls[0][0] as { where: { sale_invoice_id: unknown } };
    expect(lineArg.where.sale_invoice_id).toEqual(In(['1', '2']));
  });

  it('mostrador: customer_name vacío → "CONSUMIDOR FINAL"', async () => {
    orders = [order({ customer_name: null })];
    const result = await action.execute(COMPANY_ID);
    expect(result[0].customerName).toBe('CONSUMIDOR FINAL');
  });

  it('un pedido sin líneas devuelve lines: []', async () => {
    orders = [order({ id: '9' })];
    lines = [];
    const result = await action.execute(COMPANY_ID);
    expect(result[0].lines).toEqual([]);
  });

  it('sin pedidos activos devuelve [] y NO consulta líneas (evita el batch vacío)', async () => {
    orders = [];
    const result = await action.execute(COMPANY_ID);
    expect(result).toEqual([]);
    expect(linesFind).not.toHaveBeenCalled();
  });
});
