import { Test, type TestingModule } from '@nestjs/testing';
import { DataSource } from 'typeorm';

import { CreatePackagingAction } from '../actions/create-packaging.action';
import type { Packaging } from '../entities/packaging.entity';

/**
 * Tests unitarios de `CreatePackagingAction`.
 *
 * Cubrimos:
 *   - `company_id`, `created_by`, `created_by_id` asignados DESDE EL CONTEXTO,
 *     no del DTO (defensa multi-tenant).
 *   - `name.trim()` antes de persistir (espejo PlacePos).
 *   - `is_archived` siempre `false` al crear.
 *   - El INSERT ocurre dentro de `dataSource.transaction` (§8.8 CLAUDE.md).
 */
describe('CreatePackagingAction', () => {
  let action: CreatePackagingAction;
  let createdInput: Partial<Packaging> | null;
  let transactionSpy: jest.Mock;

  beforeEach(async () => {
    createdInput = null;

    const managerMock = {
      create: jest.fn((_entity: unknown, input: Partial<Packaging>) => {
        createdInput = input;
        return input as Packaging;
      }),
      save: jest.fn(
        (_entity: unknown, packaging: Packaging): Promise<Packaging> =>
          Promise.resolve({
            ...packaging,
            id: '1',
            created_at: new Date('2026-05-12T14:30:00.000Z'),
            updated_at: new Date('2026-05-12T14:30:00.000Z'),
          }),
      ),
    };

    transactionSpy = jest.fn(async <T>(cb: (m: typeof managerMock) => Promise<T>) =>
      cb(managerMock),
    );

    const dataSourceMock = { transaction: transactionSpy };

    const module: TestingModule = await Test.createTestingModule({
      providers: [CreatePackagingAction, { provide: DataSource, useValue: dataSourceMock }],
    }).compile();

    action = module.get(CreatePackagingAction);
  });

  it('asigna company_id y created_by* desde el contexto', async () => {
    await action.execute({ name: 'Caja x 12', value: 12 }, 42, { id: 7, fullName: 'Kike Pacheco' });

    expect(createdInput?.company_id).toBe('42');
    expect(createdInput?.created_by).toBe('Kike Pacheco');
    expect(createdInput?.created_by_id).toBe('7');
  });

  it('hace trim del name antes de persistir', async () => {
    await action.execute({ name: '   Caja x 12   ', value: 12 }, 1, { id: 1, fullName: 'Owner' });
    expect(createdInput?.name).toBe('Caja x 12');
  });

  it('inicializa is_archived = false al crear', async () => {
    await action.execute({ name: 'Bolsa', value: 5 }, 1, { id: 1, fullName: 'Owner' });
    expect(createdInput?.is_archived).toBe(false);
  });

  it('ejecuta el INSERT dentro de dataSource.transaction (§8.8 CLAUDE.md)', async () => {
    await action.execute({ name: 'X', value: 1 }, 1, { id: 1, fullName: 'Owner' });
    expect(transactionSpy).toHaveBeenCalledTimes(1);
  });
});
