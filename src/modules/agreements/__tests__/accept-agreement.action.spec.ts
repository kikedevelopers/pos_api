import type { Repository } from 'typeorm';

import type { AuthUser } from '@/common/types/jwt-payload.type';

import { AcceptAgreementAction } from '../actions/accept-agreement.action';
import { AgreementAcceptance } from '../entities/agreement-acceptance.entity';

const user: AuthUser = {
  user_id: 7,
  company_id: 3,
  name: 'Enrique',
  lastname: 'Pacheco',
  type: 'owner',
  account: 'user',
};

const makeRepo = (existing: AgreementAcceptance | null) => {
  const save = jest.fn((row: AgreementAcceptance) => Promise.resolve(row));
  const create = jest.fn((row: Partial<AgreementAcceptance>) => row as AgreementAcceptance);
  const findOne = jest.fn(() => Promise.resolve(existing));
  return {
    repo: { save, create, findOne } as unknown as Repository<AgreementAcceptance>,
    save,
    create,
    findOne,
  };
};

describe('AcceptAgreementAction', () => {
  it('crea una aceptación nueva cuando no existe', async () => {
    const { repo, create, save, findOne } = makeRepo(null);
    const action = new AcceptAgreementAction(repo);

    const result = await action.execute(
      { key: 'whatsapp_liability_disclaimer', version: 1 },
      3,
      user,
    );

    expect(findOne).toHaveBeenCalledWith({
      where: {
        company_id: '3',
        user_id: '7',
        account: 'user',
        agreement_key: 'whatsapp_liability_disclaimer',
      },
    });
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        company_id: '3',
        user_id: '7',
        account: 'user',
        agreement_key: 'whatsapp_liability_disclaimer',
        version: 1,
      }),
    );
    expect(save).toHaveBeenCalledTimes(1);
    expect(result.version).toBe(1);
  });

  it('actualiza la versión y la fecha cuando ya existe (idempotente)', async () => {
    const existing = {
      id: '99',
      company_id: '3',
      user_id: '7',
      account: 'user',
      agreement_key: 'whatsapp_liability_disclaimer',
      version: 1,
      accepted_at: new Date('2026-01-01T00:00:00.000Z'),
    } as AgreementAcceptance;
    const { repo, create, save } = makeRepo(existing);
    const action = new AcceptAgreementAction(repo);

    const result = await action.execute(
      { key: 'whatsapp_liability_disclaimer', version: 2 },
      3,
      user,
    );

    // No crea una fila nueva: reutiliza la existente.
    expect(create).not.toHaveBeenCalled();
    expect(save).toHaveBeenCalledTimes(1);
    expect(result.version).toBe(2);
    expect(result.accepted_at.getTime()).toBeGreaterThan(
      new Date('2026-01-01T00:00:00.000Z').getTime(),
    );
  });

  it('deriva user/company del JWT, nunca del payload', async () => {
    const { repo, findOne } = makeRepo(null);
    const action = new AcceptAgreementAction(repo);

    await action.execute({ key: 'terms_of_service', version: 5 }, 3, {
      ...user,
      user_id: 42,
      account: 'employee',
    });

    expect(findOne).toHaveBeenCalledWith({
      where: {
        company_id: '3',
        user_id: '42',
        account: 'employee',
        agreement_key: 'terms_of_service',
      },
    });
  });
});
