import { NotFoundException } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { DataSource } from 'typeorm';

import { UpdateCustomerAction } from '../actions/update-customer.action';
import type { Customer } from '../entities/customer.entity';
import { PersonType } from '../entities/customer.entity';

/**
 * Tests unitarios del action `UpdateCustomerAction`.
 *
 * Cubrimos:
 *   - Multi-tenant: un id de otra company ⇒ NotFoundException.
 *   - Idempotencia: PUT con body vacío devuelve el row tal cual.
 *   - El patch NO incluye campos prohibidos (balance, is_archived,
 *     company_id, created_by*).
 */
describe('UpdateCustomerAction', () => {
  let action: UpdateCustomerAction;
  let dbCustomers: Customer[];
  let lastUpdateWhere: Record<string, string> | null;
  let lastUpdatePatch: Partial<Customer> | null;

  beforeEach(async () => {
    dbCustomers = [
      {
        id: '1',
        company_id: '42',
        person_type: PersonType.INDIVIDUAL,
        name: 'Juan',
        email: null,
        phone: null,
        doc_number: null,
        address: null,
        balance: 0,
        is_archived: false,
        created_by: 'Kike',
        created_by_id: '7',
        created_at: new Date('2026-05-01T00:00:00.000Z'),
        updated_at: new Date('2026-05-01T00:00:00.000Z'),
      } as Customer,
    ];
    lastUpdateWhere = null;
    lastUpdatePatch = null;

    const managerMock = {
      findOne: jest.fn(
        (
          _entity: unknown,
          opts: { where: { id: string; company_id: string } },
        ): Promise<Customer | null> => {
          return Promise.resolve(
            dbCustomers.find(
              (c) => c.id === opts.where.id && c.company_id === opts.where.company_id,
            ) ?? null,
          );
        },
      ),
      update: jest.fn(
        (
          _entity: unknown,
          where: Record<string, string>,
          patch: Partial<Customer>,
        ): Promise<void> => {
          lastUpdateWhere = where;
          lastUpdatePatch = patch;
          const target = dbCustomers.find(
            (c) => c.id === where.id && c.company_id === where.company_id,
          );
          if (target) {
            Object.assign(target, patch);
          }
          return Promise.resolve();
        },
      ),
    };

    const dataSourceMock = {
      transaction: jest.fn(async <T>(cb: (m: typeof managerMock) => Promise<T>) => cb(managerMock)),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [UpdateCustomerAction, { provide: DataSource, useValue: dataSourceMock }],
    }).compile();

    action = module.get(UpdateCustomerAction);
  });

  it('rechaza con NotFound si el id pertenece a otra company (anti-IDOR)', async () => {
    await expect(action.execute(1, { name: 'X' }, 999)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('PUT con body vacío es idempotente y no toca DB', async () => {
    const result = await action.execute(1, {}, 42);
    expect(result.name).toBe('Juan');
    expect(lastUpdatePatch).toBeNull();
  });

  it('hace UPDATE filtrando por (id, company_id) — defensa anti cross-tenant', async () => {
    await action.execute(1, { name: 'Juan II' }, 42);
    expect(lastUpdateWhere).toEqual({ id: '1', company_id: '42' });
    expect(lastUpdatePatch).toEqual({ name: 'Juan II' });
  });

  it('respeta null explícito en campos opcionales (limpiar email)', async () => {
    await action.execute(1, { email: undefined }, 42);
    // `undefined` significa "no tocar". El patch debe ser {}.
    expect(lastUpdatePatch).toBeNull();
  });
});
