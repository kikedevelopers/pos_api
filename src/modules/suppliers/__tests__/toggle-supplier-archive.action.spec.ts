import { NotFoundException } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { DataSource } from 'typeorm';

import { ToggleSupplierArchiveAction } from '../actions/toggle-supplier-archive.action';
import type { Supplier } from '../entities/supplier.entity';

/**
 * Verifica la paridad con PlacePos:
 *   - Archiva un supplier activo (is_archived=false → true) y devuelve
 *     `{ archived: true }`.
 *   - Si ya está archivado, responde NotFound (no es toggle).
 *   - Multi-tenant: id de otra company ⇒ NotFound.
 */
describe('ToggleSupplierArchiveAction', () => {
  let action: ToggleSupplierArchiveAction;
  let dbSuppliers: Supplier[];
  let lastUpdate: { where: Record<string, string>; patch: Partial<Supplier> } | null;

  beforeEach(async () => {
    dbSuppliers = [
      makeSupplier({ id: '1', company_id: '42', is_archived: false }),
      makeSupplier({ id: '2', company_id: '42', is_archived: true }),
    ];
    lastUpdate = null;

    const managerMock = {
      findOne: jest.fn(
        (
          _entity: unknown,
          opts: { where: { id: string; company_id: string } },
        ): Promise<Supplier | null> => {
          return Promise.resolve(
            dbSuppliers.find(
              (s) => s.id === opts.where.id && s.company_id === opts.where.company_id,
            ) ?? null,
          );
        },
      ),
      update: jest.fn(
        (
          _entity: unknown,
          where: Record<string, string>,
          patch: Partial<Supplier>,
        ): Promise<void> => {
          lastUpdate = { where, patch };
          const target = dbSuppliers.find(
            (s) => s.id === where.id && s.company_id === where.company_id,
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
      providers: [ToggleSupplierArchiveAction, { provide: DataSource, useValue: dataSourceMock }],
    }).compile();

    action = module.get(ToggleSupplierArchiveAction);
  });

  it('archiva un supplier activo y devuelve { archived: true }', async () => {
    const result = await action.execute(1, 42, 7);
    expect(result).toEqual({ archived: true });
    expect(lastUpdate?.patch).toEqual({ is_archived: true });
    expect(lastUpdate?.where).toEqual({ id: '1', company_id: '42' });
  });

  it('rechaza con NotFound si el supplier ya está archivado (paridad PlacePos)', async () => {
    await expect(action.execute(2, 42, 7)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('rechaza con NotFound si el id pertenece a otra company (anti-IDOR)', async () => {
    await expect(action.execute(1, 999, 7)).rejects.toBeInstanceOf(NotFoundException);
  });
});

function makeSupplier(overrides: Partial<Supplier>): Supplier {
  return {
    id: '1',
    company_id: '42',
    legal_name: 'Acme',
    broker: null,
    address: null,
    phone: null,
    doc_number: null,
    email: null,
    accumulated_debt: 0,
    credit_balance: 0,
    is_archived: false,
    created_by: null,
    created_by_id: null,
    created_at: new Date('2026-05-01T00:00:00.000Z'),
    updated_at: new Date('2026-05-01T00:00:00.000Z'),
    ...overrides,
  } as Supplier;
}
