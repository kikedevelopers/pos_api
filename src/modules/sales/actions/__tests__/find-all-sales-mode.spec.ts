import type { Repository } from 'typeorm';

import type { AuthUser } from '@/common/types/jwt-payload.type';
import type { ResolveEffectivePermissionsAction } from '@/modules/roles/actions/resolve-effective-permissions.action';
import { FindAllSalesAction } from '../find-all-sales.action';
import { SaleInvoice } from '../../entities/sale-invoice.entity';
import { CreditNote } from '@/modules/credit-notes/entities/credit-note.entity';
import type { ListSalesQueryDto } from '../../dto/list-sales-query.dto';

// find-all-sales: el MODO del feed (mixto/pedidos primero/solo pedidos/solo
// ventas/solo crédito) filtra y ordena EN SQL. Mockeamos el QueryBuilder como
// recorder encadenable para inspeccionar qué WHERE/ORDER construye cada modo y
// el scope por created_by_id (sin canViewAllSales).

type Call = [string, ...unknown[]];

function buildAction(effective: string[] = ['canViewAllSales']) {
  let qbCalls: Call[] = [];
  const rec =
    (name: string) =>
    (...args: unknown[]) => {
      qbCalls.push([name, ...args]);
      return qb;
    };
  const qb = {
    leftJoinAndSelect: rec('leftJoinAndSelect'),
    where: rec('where'),
    andWhere: rec('andWhere'),
    orderBy: rec('orderBy'),
    addOrderBy: rec('addOrderBy'),
    limit: rec('limit'),
    getMany: jest.fn().mockResolvedValue([]),
  };
  const salesRepo = {
    createQueryBuilder: () => {
      qbCalls = [];
      return qb;
    },
  } as unknown as Repository<SaleInvoice>;
  const notesRepo = { find: jest.fn() } as unknown as Repository<CreditNote>;
  const resolvePermissions = {
    execute: jest.fn().mockResolvedValue(effective),
  } as unknown as ResolveEffectivePermissionsAction;
  const action = new FindAllSalesAction(salesRepo, notesRepo, resolvePermissions);
  return { action, getCalls: () => qbCalls };
}

const actor = (overrides: Partial<AuthUser> = {}): AuthUser =>
  ({
    user_id: 10,
    company_id: 8,
    name: 'A',
    lastname: 'B',
    type: 'employee',
    account: 'employee',
    scope: 'app',
    ...overrides,
  }) as AuthUser;

const q = (mode?: string): ListSalesQueryDto => ({ mode }) as unknown as ListSalesQueryDto;

const has = (calls: Call[], name: string, pred?: (c: Call) => boolean): boolean =>
  calls.some((c) => c[0] === name && (!pred || pred(c)));

describe('FindAllSalesAction — modo del feed', () => {
  it('mixed: sin filtro de tipo ni join de crédito extra', async () => {
    const { action, getCalls } = buildAction();
    await action.execute(8, q('mixed'), actor());
    const calls = getCalls();
    expect(has(calls, 'andWhere', (c) => String(c[1]).includes('ticket_type'))).toBe(false);
    expect(has(calls, 'andWhere', (c) => String(c[1]).includes('credit.id'))).toBe(false);
  });

  it('orders_only: filtra ticket_type = ORDER', async () => {
    const { action, getCalls } = buildAction();
    await action.execute(8, q('orders_only'), actor());
    expect(
      has(getCalls(), 'andWhere', (c) => String(c[1]).includes('s.ticket_type = :orderType')),
    ).toBe(true);
  });

  it('sales_only: filtra ticket_type = SALE', async () => {
    const { action, getCalls } = buildAction();
    await action.execute(8, q('sales_only'), actor());
    expect(
      has(getCalls(), 'andWhere', (c) => String(c[1]).includes('s.ticket_type = :saleType')),
    ).toBe(true);
  });

  it('credit_only: filtra credit.id IS NOT NULL', async () => {
    const { action, getCalls } = buildAction();
    await action.execute(8, q('credit_only'), actor());
    expect(has(getCalls(), 'andWhere', (c) => String(c[1]).includes('credit.id IS NOT NULL'))).toBe(
      true,
    );
  });

  it('orders_first: reordena con CASE de agrupación + created_at DESC', async () => {
    const { action, getCalls } = buildAction();
    await action.execute(8, q('orders_first'), actor());
    const calls = getCalls();
    expect(has(calls, 'orderBy', (c) => String(c[1]).includes('CASE WHEN'))).toBe(true);
    expect(has(calls, 'addOrderBy', (c) => c[1] === 's.created_at' && c[2] === 'DESC')).toBe(true);
  });

  it('sin mode: default mixed (no agrega filtro de tipo)', async () => {
    const { action, getCalls } = buildAction();
    await action.execute(8, q(undefined), actor());
    expect(has(getCalls(), 'andWhere', (c) => String(c[1]).includes('ticket_type'))).toBe(false);
  });

  it('scope: empleado sin canViewAllSales filtra por created_by_id', async () => {
    const { action, getCalls } = buildAction(['canAccessPOS']);
    await action.execute(8, q('mixed'), actor());
    expect(has(getCalls(), 'andWhere', (c) => String(c[1]).includes('created_by_id'))).toBe(true);
  });

  it('scope: con canViewAllSales NO filtra por created_by_id', async () => {
    const { action, getCalls } = buildAction(['canViewAllSales']);
    await action.execute(8, q('mixed'), actor());
    expect(has(getCalls(), 'andWhere', (c) => String(c[1]).includes('created_by_id'))).toBe(false);
  });
});
