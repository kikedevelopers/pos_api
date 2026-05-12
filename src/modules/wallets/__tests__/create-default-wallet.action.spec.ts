import { Test, type TestingModule } from '@nestjs/testing';

import { CreateDefaultWalletAction } from '../actions/create-default-wallet.action';
import type { Wallet } from '../entities/wallet.entity';

/**
 * Tests unitarios de `CreateDefaultWalletAction`. Cubrimos:
 *   - El nombre por defecto es "Efectivo" (paridad con seed PlacePos).
 *   - El balance inicial es 0.
 *   - `company_id` y `created_by*` se asignan desde el input.
 *   - El action NO abre transacción propia — usa el `manager` que recibe.
 */
describe('CreateDefaultWalletAction', () => {
  let action: CreateDefaultWalletAction;
  let createdInput: Partial<Wallet> | null;
  let managerMock: { getRepository: jest.Mock };

  beforeEach(async () => {
    createdInput = null;

    const repoMock = {
      create: jest.fn((input: Partial<Wallet>) => {
        createdInput = input;
        return input as Wallet;
      }),
      save: jest.fn((wallet: Wallet): Promise<Wallet> => Promise.resolve({ ...wallet, id: '1' })),
    };
    managerMock = { getRepository: jest.fn().mockReturnValue(repoMock) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [CreateDefaultWalletAction],
    }).compile();

    action = module.get(CreateDefaultWalletAction);
  });

  it('crea wallet "Efectivo" por defecto con balance 0', async () => {
    await action.execute(managerMock as never, {
      companyId: 42,
      createdBy: { id: 7, fullName: 'Kike Pacheco' },
    });

    expect(createdInput?.name).toBe('Efectivo');
    expect(createdInput?.balance).toBe(0);
    expect(createdInput?.company_id).toBe('42');
    expect(createdInput?.created_by).toBe('Kike Pacheco');
    expect(createdInput?.created_by_id).toBe('7');
    expect(createdInput?.is_archived).toBe(false);
  });

  it('respeta override de nombre si se pasa', async () => {
    await action.execute(managerMock as never, {
      companyId: 1,
      createdBy: { id: 1, fullName: 'O' },
      name: 'Mi Wallet Test',
    });
    expect(createdInput?.name).toBe('Mi Wallet Test');
  });
});
