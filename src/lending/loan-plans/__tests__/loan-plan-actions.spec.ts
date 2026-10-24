import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { QueryFailedError, type Repository } from 'typeorm';

import { CreateLoanPlanAction } from '../actions/create-loan-plan.action';
import { FindAllLoanPlansAction } from '../actions/find-all-loan-plans.action';
import { FindLoanPlanAction } from '../actions/find-loan-plan.action';
import { SetLoanPlanArchivedAction } from '../actions/set-loan-plan-archived.action';
import { UpdateLoanPlanAction } from '../actions/update-loan-plan.action';
import { toLoanPlanResponseDto } from '../dto/loan-plan-response.dto';
import type { LoanPlan } from '../entities/loan-plan.entity';

const ACTOR = { id: 17, fullName: 'Kike Pacheco' };

const uniqueViolation = (): QueryFailedError => {
  const err = new QueryFailedError('q', [], new Error('dup')) as QueryFailedError & { code?: string };
  err.code = '23505';
  return err;
};

const stored = (over: Partial<LoanPlan> = {}): LoanPlan =>
  ({
    id: '5',
    company_id: '42',
    name: 'Cuota fija 12',
    description: null,
    plan_type: 'fixed_installment',
    interest_rate: '6.0000',
    rate_period: 'monthly',
    installments_count: 12,
    collection_days: null,
    is_archived: false,
    created_by: 'X',
    created_by_id: '1',
    created_at: new Date('2026-10-24T12:00:00Z'),
    updated_at: new Date('2026-10-24T12:00:00Z'),
    ...over,
  }) as LoanPlan;

const buildRepo = (overrides: Partial<Record<'find' | 'findOne' | 'save' | 'create', jest.Mock>> = {}) =>
  ({
    find: jest.fn().mockResolvedValue([]),
    findOne: jest.fn().mockResolvedValue(null),
    create: jest.fn((input: Partial<LoanPlan>) => input),
    save: jest.fn((input: Partial<LoanPlan>) => Promise.resolve({ id: '9', ...input })),
    ...overrides,
  }) as unknown as Repository<LoanPlan> & Record<'find' | 'findOne' | 'save' | 'create', jest.Mock>;

describe('CreateLoanPlanAction', () => {
  it('normaliza, guarda la tasa como texto y toma la company del parámetro', async () => {
    const repo = buildRepo();
    await new CreateLoanPlanAction(repo).execute(
      {
        name: '  Diario  ',
        plan_type: 'daily_installment',
        interest_rate: 20,
        rate_period: 'monthly',
        installments_count: 1,
        collection_days: 26,
        company_id: '999',
      } as never,
      42,
      ACTOR,
    );
    expect(repo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'Diario',
        interest_rate: '20',
        company_id: '42',
        is_archived: false,
        created_by: 'Kike Pacheco',
        created_by_id: '17',
        installments_count: 1,
        collection_days: 26,
      }),
    );
  });

  it('400 por reglas del tipo, sin tocar la base', async () => {
    const repo = buildRepo();
    await expect(
      new CreateLoanPlanAction(repo).execute(
        { name: 'X', plan_type: 'fixed_installment', interest_rate: 6, rate_period: 'monthly' },
        42,
        ACTOR,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(repo.save).not.toHaveBeenCalled();
  });

  it('409 si el nombre ya existe; otro error sube tal cual', async () => {
    const dto = { name: 'X', plan_type: 'interest_only', interest_rate: 6, rate_period: 'monthly' } as const;
    await expect(
      new CreateLoanPlanAction(buildRepo({ save: jest.fn().mockRejectedValue(uniqueViolation()) })).execute(
        dto,
        42,
        ACTOR,
      ),
    ).rejects.toBeInstanceOf(ConflictException);

    const boom = new Error('boom');
    await expect(
      new CreateLoanPlanAction(buildRepo({ save: jest.fn().mockRejectedValue(boom) })).execute(dto, 42, ACTOR),
    ).rejects.toBe(boom);
  });
});

describe('FindLoanPlanAction / FindAllLoanPlansAction', () => {
  it('404 si no existe en la company', async () => {
    await expect(new FindLoanPlanAction(buildRepo()).execute(5, 42)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('filtra por company y, por defecto, solo activos', async () => {
    const repo = buildRepo();
    const action = new FindAllLoanPlansAction(repo);
    await action.execute(42);
    expect(repo.find).toHaveBeenLastCalledWith(
      expect.objectContaining({ where: { company_id: '42', is_archived: false } }),
    );
    await action.execute(42, true);
    expect(repo.find).toHaveBeenLastCalledWith(
      expect.objectContaining({ where: { company_id: '42' } }),
    );
  });
});

describe('UpdateLoanPlanAction', () => {
  const build = (current: LoanPlan, save?: jest.Mock) => {
    const repo = buildRepo({ findOne: jest.fn().mockResolvedValue(current), ...(save ? { save } : {}) });
    return { repo, action: new UpdateLoanPlanAction(repo, new FindLoanPlanAction(repo)) };
  };

  it('mezcla el cambio parcial con lo guardado', async () => {
    const { repo, action } = build(stored());
    await action.execute(5, { interest_rate: 5.5 }, 42);
    expect(repo.save).toHaveBeenCalledWith(
      expect.objectContaining({
        id: '5',
        name: 'Cuota fija 12',
        interest_rate: '5.5',
        installments_count: 12,
        plan_type: 'fixed_installment',
      }),
    );
  });

  it('cambiar a interés fijo limpia las cuotas', async () => {
    const { repo, action } = build(stored());
    await action.execute(5, { plan_type: 'interest_only' }, 42);
    expect(repo.save).toHaveBeenCalledWith(
      expect.objectContaining({ installments_count: null, collection_days: null }),
    );
  });

  it('descripción null explícito la borra; ausente la conserva', async () => {
    const { repo, action } = build(stored({ description: 'Clientes fijos' }));
    await action.execute(5, { name: 'Otro' }, 42);
    expect(repo.save).toHaveBeenLastCalledWith(expect.objectContaining({ description: 'Clientes fijos' }));
    await action.execute(5, { description: null }, 42);
    expect(repo.save).toHaveBeenLastCalledWith(expect.objectContaining({ description: null }));
  });

  it('400 si el resultado no cumple las reglas; 409 por nombre', async () => {
    const { action } = build(stored());
    await expect(action.execute(5, { plan_type: 'daily_installment' }, 42)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    const { action: conflicting } = build(stored(), jest.fn().mockRejectedValue(uniqueViolation()));
    await expect(conflicting.execute(5, { name: 'Ya existe' }, 42)).rejects.toBeInstanceOf(
      ConflictException,
    );
  });
});

describe('SetLoanPlanArchivedAction', () => {
  it('archiva y restaura', async () => {
    const repo = buildRepo({ findOne: jest.fn().mockResolvedValue(stored()) });
    const action = new SetLoanPlanArchivedAction(repo, new FindLoanPlanAction(repo));
    await action.execute(5, true, 42);
    expect(repo.save).toHaveBeenCalledWith(expect.objectContaining({ is_archived: true }));
  });

  it('sin cambio de estado no escribe', async () => {
    const repo = buildRepo({ findOne: jest.fn().mockResolvedValue(stored({ is_archived: true })) });
    await new SetLoanPlanArchivedAction(repo, new FindLoanPlanAction(repo)).execute(5, true, 42);
    expect(repo.save).not.toHaveBeenCalled();
  });

  it('restaurar con el nombre ocupado: 409', async () => {
    const repo = buildRepo({
      findOne: jest.fn().mockResolvedValue(stored({ is_archived: true })),
      save: jest.fn().mockRejectedValue(uniqueViolation()),
    });
    await expect(
      new SetLoanPlanArchivedAction(repo, new FindLoanPlanAction(repo)).execute(5, false, 42),
    ).rejects.toBeInstanceOf(ConflictException);
  });
});

describe('toLoanPlanResponseDto', () => {
  it('ids y tasa como número, fechas ISO', () => {
    expect(toLoanPlanResponseDto(stored({ interest_rate: '2.5125' }))).toEqual({
      id: 5,
      name: 'Cuota fija 12',
      description: null,
      plan_type: 'fixed_installment',
      interest_rate: 2.5125,
      rate_period: 'monthly',
      installments_count: 12,
      collection_days: null,
      is_archived: false,
      created_at: '2026-10-24T12:00:00.000Z',
      updated_at: '2026-10-24T12:00:00.000Z',
    });
  });
});
