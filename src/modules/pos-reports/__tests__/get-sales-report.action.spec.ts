import { BadRequestException } from '@nestjs/common';
import type { DataSource } from 'typeorm';

import type { AuthUser } from '@/common/types/jwt-payload.type';
import type { ResolveEffectivePermissionsAction } from '@/modules/roles/actions/resolve-effective-permissions.action';
import type { PermissionKey } from '@/modules/roles/internal/permission-catalog';

import { GetSalesReportAction } from '../actions/get-sales-report.action';

const OWNER: AuthUser = {
  user_id: 7,
  company_id: 42,
  name: 'Owner',
  lastname: 'Test',
  type: 'owner',
  account: 'user',
};

const EMPLOYEE: AuthUser = {
  user_id: 9,
  company_id: 42,
  name: 'Empleado',
  lastname: 'Test',
  type: 'employee',
  account: 'user',
};

/**
 * Tests unitarios de `GetSalesReportAction`.
 *
 * Foco: multi-tenancy en TODAS las subqueries (invoice principal + notas +
 * predicates de filtros). Si una rama de `applyNoteFilter` omitiera el
 * `company_id = $1` en su EXISTS, sería leak cross-tenant.
 */
describe('GetSalesReportAction', () => {
  let action: GetSalesReportAction;
  let querySpy: jest.Mock;
  // Permisos efectivos que devuelve el resolver para un EMPLEADO. owner/superadmin
  // siempre reciben `canViewAllSales` (acceso total). Configurable por test para
  // cubrir Vendedor (sin la key → solo sus ventas) y Cajero (con la key → todas).
  let employeeEffective: PermissionKey[];

  beforeEach(() => {
    querySpy = jest.fn(() => Promise.resolve([]));
    employeeEffective = [];
    const dataSourceMock = { query: querySpy } as unknown as DataSource;
    const resolvePermissionsMock = {
      execute: jest.fn((actor: { type: string }) =>
        Promise.resolve(
          actor.type === 'owner' || actor.type === 'superadmin'
            ? (['canViewAllSales'] as PermissionKey[])
            : employeeEffective,
        ),
      ),
    } as unknown as ResolveEffectivePermissionsAction;
    action = new GetSalesReportAction(dataSourceMock, resolvePermissionsMock);
  });

  function allCalls(): Array<{ sql: string; params: unknown[] }> {
    return querySpy.mock.calls.map(([sql, params]: [string, unknown[]]) => ({ sql, params }));
  }

  it('400 si faltan dateFrom o dateTo', async () => {
    await expect(action.execute(42, { dateFrom: '2026-05-01' }, OWNER)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(action.execute(42, { dateTo: '2026-05-31' }, OWNER)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('multi-tenant: cada query filtra company_id en sale_invoices, sale_credits y credit_notes', async () => {
    await action.execute(42, { dateFrom: '2026-05-01', dateTo: '2026-05-31' }, OWNER);
    const calls = allCalls();
    expect(calls.length).toBe(2); // invoice query + notes query.
    for (const c of calls) {
      expect(c.sql).toMatch(/si\.company_id\s*=\s*\$1/);
      expect(c.params[0]).toBe('42');
    }
    // El query principal debe filtrar el LEFT JOIN sale_credits por company_id.
    const invoiceCall = calls[0];
    expect(invoiceCall.sql).toMatch(/sc\.company_id\s*=\s*\$1/);
    // Sub-selects de credit_notes también filtran por company_id.
    expect(invoiceCall.sql).toMatch(/cn2\.company_id\s*=\s*\$1/);
  });

  it('noteFilter=FULL_VOID añade EXISTS con cn.company_id = $1', async () => {
    await action.execute(
      42,
      {
        dateFrom: '2026-05-01',
        dateTo: '2026-05-31',
        noteFilter: 'FULL_VOID',
      },
      OWNER,
    );
    const invoiceCall = allCalls()[0];
    expect(invoiceCall.sql).toMatch(/cn\.company_id\s*=\s*\$1/);
    expect(invoiceCall.sql).toMatch(/cn\.operation_type = 'FULL_VOID'/);
  });

  it('aislamiento cross-tenant: jamás emite filtro de company con placeholder distinto a $1', async () => {
    await action.execute(
      42,
      {
        dateFrom: '2026-05-01',
        dateTo: '2026-05-31',
        noteFilter: 'WITH_ADJUSTMENTS',
      },
      OWNER,
    );
    for (const c of allCalls()) {
      const matches = c.sql.match(/company_id\s*=\s*\$\d+/g) ?? [];
      for (const m of matches) {
        expect(m).toMatch(/company_id\s*=\s*\$1/);
      }
    }
  });

  it('ticketTypes CSV se aplica como IN con placeholders', async () => {
    await action.execute(
      42,
      {
        dateFrom: '2026-05-01',
        dateTo: '2026-05-31',
        ticketTypes: ['SALE', 'ORDER'],
      },
      OWNER,
    );
    const invoiceCall = allCalls()[0];
    expect(invoiceCall.sql).toMatch(/si\.ticket_type::text IN \(\$\d+,\$\d+\)/);
    expect(invoiceCall.params).toContain('SALE');
    expect(invoiceCall.params).toContain('ORDER');
  });

  it('categoryIds: EXISTS sobre sale_invoice_lines→products filtrando company_id $1 y category_id IN', async () => {
    await action.execute(
      42,
      {
        dateFrom: '2026-05-01',
        dateTo: '2026-05-31',
        categoryIds: [3, 7],
      },
      OWNER,
    );
    const invoiceCall = allCalls()[0];
    // Semi-join: EXISTS contra las líneas + producto, sin duplicar filas.
    expect(invoiceCall.sql).toMatch(/EXISTS\s*\(/);
    expect(invoiceCall.sql).toMatch(/FROM sale_invoice_lines sil/);
    expect(invoiceCall.sql).toMatch(
      /JOIN products p ON p\.id = sil\.product_id AND p\.company_id = \$1/,
    );
    expect(invoiceCall.sql).toMatch(/sil\.company_id\s*=\s*\$1/);
    expect(invoiceCall.sql).toMatch(/p\.category_id IN \(\$\d+,\$\d+\)/);
    // Los ids de categoría se enlazan como parámetros (no interpolados).
    expect(invoiceCall.params).toContain(3);
    expect(invoiceCall.params).toContain(7);
  });

  it('categoryIds vacío/ausente: NO añade el EXISTS de categoría', async () => {
    await action.execute(42, { dateFrom: '2026-05-01', dateTo: '2026-05-31' }, OWNER);
    const invoiceCall = allCalls()[0];
    expect(invoiceCall.sql).not.toMatch(/p\.category_id IN/);
  });

  it('owner/manager: NO añade filtro por created_by_id (ven todas las ventas)', async () => {
    await action.execute(42, { dateFrom: '2026-05-01', dateTo: '2026-05-31' }, OWNER);
    for (const c of allCalls()) {
      expect(c.sql).not.toMatch(/created_by_id/);
    }
  });

  it('empleado SIN canViewAllSales (Vendedor/legacy): filtra invoices y notas por created_by_id', async () => {
    employeeEffective = ['canAccessPOS', 'canAccessSalesReport']; // Vendedor: sin canViewAllSales.
    await action.execute(42, { dateFrom: '2026-05-01', dateTo: '2026-05-31' }, EMPLOYEE);
    const [invoiceCall, notesCall] = allCalls();
    // Ambas queries restringen al creador; el id va como string (columna texto).
    expect(invoiceCall.sql).toMatch(/si\.created_by_id\s*=\s*\$\d+/);
    expect(invoiceCall.params).toContain(String(EMPLOYEE.user_id));
    expect(notesCall.sql).toMatch(/cn\.created_by_id\s*=\s*\$\d+/);
    expect(notesCall.params).toContain(String(EMPLOYEE.user_id));
  });

  it('empleado CON canViewAllSales (Cajero): NO filtra por created_by_id (ve todas las ventas)', async () => {
    employeeEffective = ['canAccessSalesReport', 'canViewAllSales']; // Cajero: ve todo.
    await action.execute(42, { dateFrom: '2026-05-01', dateTo: '2026-05-31' }, EMPLOYEE);
    for (const c of allCalls()) {
      expect(c.sql).not.toMatch(/created_by_id/);
    }
  });
});
