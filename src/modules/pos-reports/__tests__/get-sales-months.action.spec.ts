import type { DataSource } from 'typeorm';

import type { AuthUser } from '@/common/types/jwt-payload.type';
import type { GetIncludeOrdersInReportsAction } from '@/modules/app-settings/actions/get-include-orders-in-reports.action';
import type { ResolveEffectivePermissionsAction } from '@/modules/roles/actions/resolve-effective-permissions.action';
import type { PermissionKey } from '@/modules/roles/internal/permission-catalog';

import { GetSalesMonthsAction } from '../actions/get-sales-months.action';

const OWNER: AuthUser = {
  user_id: 7,
  company_id: 42,
  name: 'Owner',
  lastname: 'Test',
  type: 'owner',
  account: 'user',
  scope: 'app',
};

const EMPLOYEE: AuthUser = {
  user_id: 9,
  company_id: 42,
  name: 'Empleado',
  lastname: 'Test',
  type: 'employee',
  account: 'user',
  scope: 'app',
};

/**
 * Meses con ventas para el selector del extracto mensual.
 *
 * Lo que se protege aquí: el aislamiento por company (un leak en este GROUP BY
 * le mostraría a un tenant los meses de otro), la agrupación en hora Colombia
 * —en UTC, una venta de las 8 p.m. del 31 cae en el mes siguiente y desaparece
 * del extracto— y que el criterio de tipos sea el mismo que usará el extracto,
 * o el selector ofrecería meses que abren un PDF vacío.
 */
describe('GetSalesMonthsAction', () => {
  let action: GetSalesMonthsAction;
  let querySpy: jest.Mock;
  let employeeEffective: PermissionKey[];
  let includeOrders: boolean;

  beforeEach(() => {
    querySpy = jest.fn(() => Promise.resolve([]));
    employeeEffective = [];
    includeOrders = false;
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
    const getIncludeOrdersMock = {
      execute: jest.fn(() => Promise.resolve({ enabled: includeOrders })),
    } as unknown as GetIncludeOrdersInReportsAction;

    action = new GetSalesMonthsAction(
      dataSourceMock,
      resolvePermissionsMock,
      getIncludeOrdersMock,
    );
  });

  const lastSql = (): string => String(querySpy.mock.calls[0][0]);
  const lastParams = (): unknown[] => querySpy.mock.calls[0][1] as unknown[];

  it('filtra por company (aislamiento entre tenants)', async () => {
    await action.execute(42, OWNER);

    expect(lastSql()).toContain('si.company_id = $1');
    expect(lastParams()[0]).toBe('42');
  });

  it('agrupa por la fecha de VENTA, no por la de registro', async () => {
    // Es lo que hace que el mes del extracto coincida con el del Resumen.
    await action.execute(42, OWNER);

    expect(lastSql()).toContain('COALESCE(si.sold_at, si.created_at)');
  });

  it('agrupa en hora Colombia', async () => {
    // En UTC, una venta del 31 a las 8 p.m. cae en el mes siguiente.
    await action.execute(42, OWNER);

    expect(lastSql()).toContain("AT TIME ZONE 'America/Bogota'");
    expect(lastSql()).toContain("'YYYY-MM'");
  });

  it('excluye las ventas anuladas del conteo', async () => {
    await action.execute(42, OWNER);

    expect(lastSql()).toContain('si.is_deleted = false');
  });

  it('con el flag OFF solo cuenta ventas', async () => {
    await action.execute(42, OWNER);

    expect(lastSql()).toContain("si.ticket_type::text = 'SALE'");
    expect(lastSql()).not.toContain("IN ('SALE','ORDER')");
  });

  it('con el flag ON también cuenta pedidos', async () => {
    // El flag suma los pedidos a los ingresos; el extracto los listará, así que
    // el selector debe ofrecer sus meses.
    includeOrders = true;

    await action.execute(42, OWNER);

    expect(lastSql()).toContain("si.ticket_type::text IN ('SALE','ORDER')");
  });

  it('devuelve los meses ordenados del más viejo al más nuevo', async () => {
    // El selector los pinta en ese orden: marzo, abril, mayo…
    querySpy.mockResolvedValueOnce([
      { month: '2026-03', sales_count: '120' },
      { month: '2026-04', sales_count: '98' },
    ]);

    const result = await action.execute(42, OWNER);

    expect(lastSql()).toContain('ORDER BY 1 ASC');
    expect(result.months).toEqual([
      { month: '2026-03', salesCount: 120 },
      { month: '2026-04', salesCount: 98 },
    ]);
  });

  it('convierte el conteo a número (postgres devuelve string en COUNT)', async () => {
    querySpy.mockResolvedValueOnce([{ month: '2026-03', sales_count: '7' }]);

    const result = await action.execute(42, OWNER);

    expect(result.months[0].salesCount).toBe(7);
    expect(typeof result.months[0].salesCount).toBe('number');
  });

  it('sin ventas devuelve la lista vacía, no un error', async () => {
    const result = await action.execute(42, OWNER);

    expect(result.months).toEqual([]);
  });

  it('el owner ve los meses de todas las ventas', async () => {
    await action.execute(42, OWNER);

    expect(lastSql()).not.toContain('si.created_by_id');
  });

  it('un empleado sin canViewAllSales solo ve los meses de SUS ventas', async () => {
    // Coherencia con el informe: si solo ve sus ventas, el selector no puede
    // ofrecerle un mes que para él sale vacío.
    employeeEffective = ['canAccessSettings'] as PermissionKey[];

    await action.execute(42, EMPLOYEE);

    expect(lastSql()).toContain('si.created_by_id = $2');
    expect(lastParams()[1]).toBe('9');
  });

  it('un empleado CON canViewAllSales ve todos los meses', async () => {
    employeeEffective = ['canViewAllSales', 'canAccessSettings'] as PermissionKey[];

    await action.execute(42, EMPLOYEE);

    expect(lastSql()).not.toContain('si.created_by_id');
  });
});
