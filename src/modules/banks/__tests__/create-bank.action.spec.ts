import { Test, type TestingModule } from '@nestjs/testing';
import { DataSource } from 'typeorm';

import { FinancialMovementsService } from '@/modules/financial-movements/financial-movements.service';

import { CreateBankAction } from '../actions/create-bank.action';
import { BankAccountType, type Bank } from '../entities/bank.entity';

/**
 * Tests unitarios de `CreateBankAction`.
 *
 * Cubrimos:
 *   - `company_id`, `created_by`, `created_by_id` asignados DESDE EL
 *     CONTEXTO (defensa multi-tenant). El DTO no manda esos campos.
 *   - `initial_balance > 0` → llama a `FinancialMovementsService.record`
 *     con concept INITIAL_BALANCE y `destination_type='bank'`.
 *   - `initial_balance` ausente/cero → NO llama a record.
 *   - El INSERT vive dentro de `dataSource.transaction` (§8.8).
 */
describe('CreateBankAction', () => {
  let action: CreateBankAction;
  let createdInput: Partial<Bank> | null;
  let transactionSpy: jest.Mock;
  let recordSpy: jest.Mock;

  beforeEach(async () => {
    createdInput = null;

    const managerMock = {
      create: jest.fn((_entity: unknown, input: Partial<Bank>) => {
        createdInput = input;
        return input as Bank;
      }),
      save: jest.fn(
        (_entity: unknown, bank: Bank): Promise<Bank> =>
          Promise.resolve({
            ...bank,
            id: '1',
            created_at: new Date('2026-05-12T14:30:00.000Z'),
            updated_at: new Date('2026-05-12T14:30:00.000Z'),
          }),
      ),
    };

    transactionSpy = jest.fn(async <T>(cb: (m: typeof managerMock) => Promise<T>) =>
      cb(managerMock),
    );
    recordSpy = jest.fn().mockResolvedValue(undefined);

    const dataSourceMock = { transaction: transactionSpy };
    const financialMovementsServiceMock = { record: recordSpy };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CreateBankAction,
        { provide: DataSource, useValue: dataSourceMock },
        { provide: FinancialMovementsService, useValue: financialMovementsServiceMock },
      ],
    }).compile();

    action = module.get(CreateBankAction);
  });

  it('asigna company_id y created_by* desde el contexto', async () => {
    await action.execute(
      {
        name: 'Banco Mercantil',
        account_number: '0105-0000-00-0000000000',
        account_type: BankAccountType.SAVINGS,
      },
      42,
      { id: 7, fullName: 'Kike Pacheco' },
    );

    expect(createdInput?.company_id).toBe('42');
    expect(createdInput?.created_by).toBe('Kike Pacheco');
    expect(createdInput?.created_by_id).toBe('7');
  });

  it('inicializa is_archived = false y available_in_pos default = false', async () => {
    await action.execute(
      {
        name: 'B',
        account_number: 'X',
        account_type: BankAccountType.CHECKING,
      },
      1,
      { id: 1, fullName: 'Owner' },
    );
    expect(createdInput?.is_archived).toBe(false);
    expect(createdInput?.available_in_pos).toBe(false);
  });

  it('con initial_balance > 0 genera FinancialMovement INITIAL_BALANCE', async () => {
    await action.execute(
      {
        name: 'B',
        account_number: 'X',
        account_type: BankAccountType.SAVINGS,
        initial_balance: '500.00',
      },
      1,
      { id: 1, fullName: 'Owner' },
    );

    expect(recordSpy).toHaveBeenCalledTimes(1);
    const calls = recordSpy.mock.calls as Array<
      [
        unknown,
        {
          companyId: number;
          destination_type: string;
          concept: string;
          amount: number;
        },
      ]
    >;
    const args = calls[0]?.[1];
    if (!args) {
      throw new Error('Expected record call');
    }
    expect(args.companyId).toBe(1);
    expect(args.destination_type).toBe('bank');
    expect(args.concept).toBe('INITIAL_BALANCE');
    expect(args.amount).toBe(500);
  });

  it('sin initial_balance NO genera FinancialMovement', async () => {
    await action.execute(
      {
        name: 'B',
        account_number: 'X',
        account_type: BankAccountType.SAVINGS,
      },
      1,
      { id: 1, fullName: 'Owner' },
    );
    expect(recordSpy).not.toHaveBeenCalled();
  });

  it('ejecuta dentro de dataSource.transaction (§8.8 CLAUDE.md)', async () => {
    await action.execute(
      { name: 'B', account_number: 'X', account_type: BankAccountType.SAVINGS },
      1,
      { id: 1, fullName: 'O' },
    );
    expect(transactionSpy).toHaveBeenCalledTimes(1);
  });
});
