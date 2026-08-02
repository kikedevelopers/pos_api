import type { EntityManager } from 'typeorm';

import { ProductType } from '../../entities/product.entity';
import { resolveComboRecipes } from '../resolve-combo-recipe.helper';

jest.mock('../accessible-products.helper', () => ({
  resolveAccessibleProducts: jest.fn(),
}));

import { resolveAccessibleProducts } from '../accessible-products.helper';

const accessibleMock = resolveAccessibleProducts as jest.MockedFunction<
  typeof resolveAccessibleProducts
>;

interface SeedRow {
  company_id: string;
  combo_product_id: string;
  component_product_id: string;
  quantity: number;
}

function ref(over: {
  id: number;
  productType?: string;
  ownerCompanyId?: number;
}): ReturnType<typeof buildRef> {
  return buildRef(over);
}

function buildRef(over: { id: number; productType?: string; ownerCompanyId?: number }) {
  return {
    id: over.id,
    ownerCompanyId: over.ownerCompanyId ?? 42,
    parentId: null,
    packagingId: null,
    name: `P${over.id}`,
    isShared: (over.ownerCompanyId ?? 42) !== 42,
    productType: over.productType ?? ProductType.SIMPLE,
  };
}

/** `manager.find` que filtra por company dueña + ids, como la query real. */
function makeManager(rows: SeedRow[]): { manager: EntityManager; find: jest.Mock } {
  const find = jest.fn((_entity: unknown, options: { where: unknown }) => {
    const conditions = (Array.isArray(options.where) ? options.where : [options.where]) as Array<{
      company_id: string;
      combo_product_id: { _value?: string[] };
    }>;
    return Promise.resolve(
      rows.filter((r) =>
        conditions.some(
          (c) =>
            c.company_id === r.company_id &&
            (c.combo_product_id._value ?? []).includes(r.combo_product_id),
        ),
      ),
    );
  });
  return { manager: { find } as unknown as EntityManager, find };
}

function seedAccessible(refs: ReturnType<typeof buildRef>[]): void {
  accessibleMock.mockResolvedValue(new Map(refs.map((r) => [r.id, r])));
}

/**
 * FIX #3 — Este helper produce el snapshot que se congela en la línea. Un fallo
 * aquí no rompe la venta: la corrompe después, al devolver stock que no
 * corresponde. De ahí que cubra explícitamente el "no congelar" (productos que
 * no son combo) tanto como el "congelar bien".
 */
describe('resolveComboRecipes', () => {
  beforeEach(() => {
    accessibleMock.mockReset();
  });

  it('congela la receta de un combo', async () => {
    seedAccessible([ref({ id: 9, productType: ProductType.COMBO })]);
    const { manager } = makeManager([
      { company_id: '42', combo_product_id: '9', component_product_id: '1', quantity: 25 },
      { company_id: '42', combo_product_id: '9', component_product_id: '2', quantity: 30 },
    ]);

    const result = await resolveComboRecipes(manager, 42, [9]);

    expect(result.get(9)).toEqual([
      { component_product_id: 1, quantity: 25 },
      { component_product_id: 2, quantity: 30 },
    ]);
  });

  it('OMITE los productos que no son combo (no tienen receta que congelar)', async () => {
    seedAccessible([ref({ id: 1 }), ref({ id: 9, productType: ProductType.COMBO })]);
    const { manager } = makeManager([
      { company_id: '42', combo_product_id: '9', component_product_id: '1', quantity: 25 },
    ]);

    const result = await resolveComboRecipes(manager, 42, [1, 9]);

    expect(result.has(1)).toBe(false);
    expect(result.has(9)).toBe(true);
  });

  it('un combo SIN receta se congela como array vacío, no como ausente', async () => {
    seedAccessible([ref({ id: 9, productType: ProductType.COMBO })]);
    const { manager } = makeManager([]);

    const result = await resolveComboRecipes(manager, 42, [9]);

    // `[]` significa "no tenía componentes al vender" → la devolución no debe
    // reexpandir contra la receta que exista ese día.
    expect(result.get(9)).toEqual([]);
  });

  it('no consulta nada si no hay ids', async () => {
    const { manager, find } = makeManager([]);
    const result = await resolveComboRecipes(manager, 42, []);
    expect(result.size).toBe(0);
    expect(find).not.toHaveBeenCalled();
    expect(accessibleMock).not.toHaveBeenCalled();
  });

  it('no consulta combo_components si ningún id es combo', async () => {
    seedAccessible([ref({ id: 1 }), ref({ id: 2 })]);
    const { manager, find } = makeManager([]);

    const result = await resolveComboRecipes(manager, 42, [1, 2]);

    expect(result.size).toBe(0);
    expect(find).not.toHaveBeenCalled();
  });

  it('deduplica ids repetidos', async () => {
    seedAccessible([ref({ id: 9, productType: ProductType.COMBO })]);
    const { manager } = makeManager([
      { company_id: '42', combo_product_id: '9', component_product_id: '1', quantity: 25 },
    ]);

    const result = await resolveComboRecipes(manager, 42, [9, 9, 9]);

    expect(result.get(9)).toHaveLength(1);
  });

  it('un id NO accesible simplemente no aparece (nunca lanza)', async () => {
    seedAccessible([]);
    const { manager } = makeManager([]);

    const result = await resolveComboRecipes(manager, 42, [999]);

    expect(result.size).toBe(0);
  });

  describe('multi-tenant', () => {
    it('cross-company: lee la receta en la company DUEÑA del combo', async () => {
      // Sucursal 42 vendiendo un combo compartido por el principal (7).
      seedAccessible([ref({ id: 9, productType: ProductType.COMBO, ownerCompanyId: 7 })]);
      const { manager } = makeManager([
        { company_id: '7', combo_product_id: '9', component_product_id: '1', quantity: 25 },
        // Ruido: una receta homónima en la company activa NO debe colarse.
        { company_id: '42', combo_product_id: '9', component_product_id: '5', quantity: 99 },
      ]);

      const result = await resolveComboRecipes(manager, 42, [9], true);

      expect(result.get(9)).toEqual([{ component_product_id: 1, quantity: 25 }]);
    });

    it('modo estricto: ignora un combo cuya dueña no es la company activa', async () => {
      seedAccessible([ref({ id: 9, productType: ProductType.COMBO, ownerCompanyId: 7 })]);
      const { manager, find } = makeManager([
        { company_id: '7', combo_product_id: '9', component_product_id: '1', quantity: 25 },
      ]);

      const result = await resolveComboRecipes(manager, 42, [9], false);

      expect(result.size).toBe(0);
      expect(find).not.toHaveBeenCalled();
    });

    it('agrupa por dueña cuando conviven combos propios y compartidos', async () => {
      seedAccessible([
        ref({ id: 9, productType: ProductType.COMBO }),
        ref({ id: 10, productType: ProductType.COMBO, ownerCompanyId: 7 }),
      ]);
      const { manager } = makeManager([
        { company_id: '42', combo_product_id: '9', component_product_id: '1', quantity: 25 },
        { company_id: '7', combo_product_id: '10', component_product_id: '2', quantity: 30 },
      ]);

      const result = await resolveComboRecipes(manager, 42, [9, 10], true);

      expect(result.get(9)).toEqual([{ component_product_id: 1, quantity: 25 }]);
      expect(result.get(10)).toEqual([{ component_product_id: 2, quantity: 30 }]);
    });
  });
});
