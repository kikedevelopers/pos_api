import type { DataSource } from 'typeorm';

import type { AuthUser } from '@/common/types/jwt-payload.type';
import type { GetIncludeOrdersInReportsAction } from '@/modules/app-settings/actions/get-include-orders-in-reports.action';
import type { ResolveEffectivePermissionsAction } from '@/modules/roles/actions/resolve-effective-permissions.action';
import type { PermissionKey } from '@/modules/roles/internal/permission-catalog';

import { GetSalesReportAction } from '../actions/get-sales-report.action';
import { mapNoteToTicket, salesDateFieldExpr, type NoteRow } from '../internal/sales-report-shared';

const OWNER: AuthUser = {
  user_id: 7,
  company_id: 42,
  name: 'Owner',
  lastname: 'Test',
  type: 'owner',
  account: 'user',
};

const SOLD_EXPR = 'COALESCE(si.sold_at, si.created_at)';

/**
 * Por qué fecha se recorta el rango del informe. Espejo del test de placepos
 * (`salesStatementDateField.test.ts`).
 *
 * El listado de la pantalla recorta por `created_at` (cuándo se REGISTRÓ la
 * factura) y el módulo Resumen por `COALESCE(sold_at, created_at)` (cuándo se
 * VENDIÓ). La diferencia solo aparece en pedidos cobrados días después, y era
 * exactamente lo que impedía que el extracto mensual cuadrara con el Resumen.
 */
describe('GetSalesReportAction · fecha del rango', () => {
  let action: GetSalesReportAction;
  let querySpy: jest.Mock;

  beforeEach(() => {
    querySpy = jest.fn(() => Promise.resolve([]));
    const dataSourceMock = { query: querySpy } as unknown as DataSource;
    const resolvePermissionsMock = {
      execute: jest.fn(() => Promise.resolve(['canViewAllSales'] as PermissionKey[])),
    } as unknown as ResolveEffectivePermissionsAction;
    const getIncludeOrdersMock = {
      execute: jest.fn(() => Promise.resolve({ enabled: false })),
    } as unknown as GetIncludeOrdersInReportsAction;

    action = new GetSalesReportAction(
      dataSourceMock,
      resolvePermissionsMock,
      getIncludeOrdersMock,
    );
  });

  const invoiceSql = (): string => String(querySpy.mock.calls[0][0]);

  describe('salesDateFieldExpr', () => {
    it('sold_at usa el COALESCE, que es el que tiene índice', () => {
      expect(salesDateFieldExpr('sold_at')).toBe(SOLD_EXPR);
    });

    it('created_at y el default caen en la fecha de registro', () => {
      expect(salesDateFieldExpr('created_at')).toBe('si.created_at');
      expect(salesDateFieldExpr(undefined)).toBe('si.created_at');
    });
  });

  it('sin dateField conserva el criterio histórico del listado', async () => {
    await action.execute(42, { dateFrom: '2026-07-01', dateTo: '2026-07-31' }, OWNER);

    expect(invoiceSql()).toContain('si.created_at >=');
    expect(invoiceSql()).not.toContain(`${SOLD_EXPR} >=`);
  });

  it('con dateField=sold_at recorta y ordena por la fecha de venta', async () => {
    await action.execute(
      42,
      { dateFrom: '2026-07-01', dateTo: '2026-07-31', dateField: 'sold_at' },
      OWNER,
    );

    expect(invoiceSql()).toContain(`${SOLD_EXPR} >=`);
    expect(invoiceSql()).toContain(`${SOLD_EXPR} <=`);
    // Filtrar por una fecha y ordenar por otra descoloca justo los pedidos, que
    // son los únicos donde las dos fechas difieren.
    expect(invoiceSql()).toContain(`ORDER BY ${SOLD_EXPR} DESC`);
  });

  it('la consulta trae la fecha de venta de cada factura', async () => {
    await action.execute(42, { dateFrom: '2026-07-01', dateTo: '2026-07-31' }, OWNER);

    expect(invoiceSql()).toContain('COALESCE(si.sold_at, si.created_at) AS sold_at');
  });
});

describe('mapNoteToTicket · identidad de la venta ajustada', () => {
  const makeNote = (over: Partial<NoteRow> = {}): NoteRow => ({
    id: '11',
    note_number: 'NC-3',
    note_type: 'CREDIT',
    operation_type: 'PARTIAL_VOID',
    sale_invoice_id: '900',
    total: 5000,
    note_cost: 3000,
    created_by: 'Ana',
    created_at: new Date('2026-07-05T15:00:00.000Z'),
    parent_ticket_number: 'VTA-500',
    parent_sale_number: 'V-500',
    parent_sold_at: new Date('2026-06-28T14:00:00.000Z'),
    customer_name: 'Cliente',
    ...over,
  });

  it('expone el ticket y la fecha de la venta que ajusta', () => {
    // Sin esto, una nota de julio sobre una venta de junio aparece en el
    // extracto sin decir a qué ticket pertenece.
    const row = mapNoteToTicket(makeNote());

    expect(row.parentTicketNumber).toBe('VTA-500');
    expect(row.parentSaleNumber).toBe('V-500');
    expect(row.parentSoldAt).toBe('2026-06-28T14:00:00.000Z');
  });

  it('sin fecha del padre cae en la fecha de la nota', () => {
    const row = mapNoteToTicket(makeNote({ parent_sold_at: null as never }));

    expect(row.parentSoldAt).toBe('2026-07-05T15:00:00.000Z');
  });

  it('sigue firmando el total: la nota de crédito resta', () => {
    const row = mapNoteToTicket(makeNote());

    expect(row.consolidatedTotal).toBe(-5000);
  });
});
