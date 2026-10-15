import type { EntityManager } from 'typeorm';

import { Product } from '../../entities/product.entity';
import { propagateCategoryToChildren } from '../propagate-category.helper';

describe('propagateCategoryToChildren', () => {
  const build = (affected: number | undefined) => {
    const update = jest.fn((..._args: unknown[]) => Promise.resolve({ affected }));
    return { manager: { update } as unknown as EntityManager, update };
  };

  it('asigna la categoría del base a sus hijos, scoped por company', async () => {
    const { manager, update } = build(3);
    const res = await propagateCategoryToChildren({ manager, companyId: 13, parentId: 7, categoryId: 4 });
    expect(update).toHaveBeenCalledWith(
      Product,
      { parent_id: '7', company_id: '13' },
      { category_id: '4' },
    );
    expect(res.updatedChildren).toBe(3);
  });

  it('categoryId null deja a los hijos sin categoría', async () => {
    const { manager, update } = build(1);
    await propagateCategoryToChildren({ manager, companyId: 13, parentId: 7, categoryId: null });
    expect(update.mock.calls[0][2]).toEqual({ category_id: null });
  });

  it('sin hijos (affected undefined) reporta 0', async () => {
    const { manager } = build(undefined);
    const res = await propagateCategoryToChildren({ manager, companyId: 13, parentId: 7, categoryId: 4 });
    expect(res.updatedChildren).toBe(0);
  });
});
