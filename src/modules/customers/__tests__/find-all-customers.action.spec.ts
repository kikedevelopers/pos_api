import { Test, type TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import type { Repository } from 'typeorm';

import { FindAllCustomersAction } from '../actions/find-all-customers.action';
import { Customer } from '../entities/customer.entity';

/**
 * Tests de `FindAllCustomersAction` centrados en el armado del QueryBuilder:
 *   - Siempre filtra por company_id y carga la relación `category`.
 *   - `category_id` añade el filtro por categoría (normalizado a string).
 *   - Sin `category_id`, no se añade ese filtro.
 */
describe('FindAllCustomersAction', () => {
  let action: FindAllCustomersAction;
  let qb: {
    leftJoinAndSelect: jest.Mock;
    where: jest.Mock;
    andWhere: jest.Mock;
    orderBy: jest.Mock;
    limit: jest.Mock;
    offset: jest.Mock;
    getMany: jest.Mock;
  };

  beforeEach(async () => {
    qb = {
      leftJoinAndSelect: jest.fn(() => qb),
      where: jest.fn(() => qb),
      andWhere: jest.fn(() => qb),
      orderBy: jest.fn(() => qb),
      limit: jest.fn(() => qb),
      offset: jest.fn(() => qb),
      getMany: jest.fn(() => Promise.resolve([])),
    };
    const repoMock = { createQueryBuilder: jest.fn(() => qb) } as unknown as Repository<Customer>;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        FindAllCustomersAction,
        { provide: getRepositoryToken(Customer), useValue: repoMock },
      ],
    }).compile();

    action = module.get(FindAllCustomersAction);
  });

  it('siempre carga la relación category y filtra por company_id', async () => {
    await action.execute(42, {});
    expect(qb.leftJoinAndSelect).toHaveBeenCalledWith('c.category', 'category');
    expect(qb.where).toHaveBeenCalledWith('c.company_id = :companyId', { companyId: '42' });
  });

  it('añade el filtro por categoría cuando viene category_id (string)', async () => {
    await action.execute(42, { category_id: 3 });
    expect(qb.andWhere).toHaveBeenCalledWith('c.category_id = :categoryId', { categoryId: '3' });
  });

  it('no añade filtro de categoría cuando category_id está ausente', async () => {
    await action.execute(42, {});
    const calls = qb.andWhere.mock.calls as unknown as Array<[string, ...unknown[]]>;
    const calledWithCategory = calls.some(
      ([clause]) => typeof clause === 'string' && clause.includes('c.category_id'),
    );
    expect(calledWithCategory).toBe(false);
  });
});
