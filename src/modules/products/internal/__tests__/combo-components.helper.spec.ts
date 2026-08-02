import { BadRequestException } from '@nestjs/common';
import { FindOperator, type EntityManager } from 'typeorm';

import {
  assertNotUsedInActiveCombos,
  clearComboComponents,
  comboCostFromComponents,
  findCombosUsingComponents,
  resolveComboComponents,
  syncComboComponents,
  type ResolvedComboComponent,
} from '../combo-components.helper';

/**
 * Capa de VALIDACIÓN y persistencia de la receta. Espejo del suite de placepos
 * (`comboOperations.test.ts`): los mensajes son parte del contrato — el
 * formulario los muestra tal cual y ambos repos deben decir lo MISMO, palabra
 * por palabra, así que se asertan literalmente.
 *
 * Además cubre lo que placepos no tiene: el aislamiento por `company_id`.
 */
describe('combo-components.helper — validación y persistencia de la receta', () => {
  const COMPANY = 13;
  const OTRA_COMPANY = 99;

  interface ProductRow {
    id: number;
    company_id: number;
    name: string;
    cost: number;
    parent_id: number | null;
    packaging_id: number | null;
    product_type: 'SIMPLE' | 'COMBO';
    is_archived: boolean;
    stock: number;
  }

  interface RecipeRow {
    id: number;
    company_id: number;
    combo_product_id: number;
    component_product_id: number;
    quantity: number;
  }

  /** Desenvuelve un FindOperator (posiblemente anidado, `Not(In([...]))`). */
  const unwrapIds = (operator: unknown): number[] => {
    let current: unknown = operator;
    while (current instanceof FindOperator) {
      current = current.value;
    }
    return Array.isArray(current) ? (current as unknown[]).map(Number) : [];
  };

  const idsOf = (where: Record<string, unknown> | undefined, key: string): number[] => {
    const clause = where?.[key];
    if (clause === undefined || clause === null) {
      return [];
    }
    if (clause instanceof FindOperator) {
      return unwrapIds(clause);
    }
    return [Number(clause)];
  };

  class Harness {
    products: ProductRow[] = [];
    packagings: Array<{ id: number; company_id: number; value: number }> = [];
    recipe: RecipeRow[] = [];
    private nextRecipeId = 1;

    seedProduct(row: Partial<ProductRow> & { id: number; name: string }): void {
      this.products.push({
        company_id: COMPANY,
        cost: 0,
        parent_id: null,
        packaging_id: null,
        product_type: 'SIMPLE',
        is_archived: false,
        stock: 0,
        ...row,
      });
    }

    seedPackaging(id: number, value: number, companyId = COMPANY): void {
      this.packagings.push({ id, company_id: companyId, value });
    }

    seedRecipe(combo: number, component: number, quantity: number, companyId = COMPANY): void {
      this.recipe.push({
        id: this.nextRecipeId++,
        company_id: companyId,
        combo_product_id: combo,
        component_product_id: component,
        quantity,
      });
    }

    // Las funciones del mock son arrow: capturan `this` léxicamente del getter,
    // así que apuntan a la instancia sin necesidad de aliasarlo.
    get manager(): EntityManager {
      return {
        find: (
          entity: { name?: string } | string,
          options: { where?: Record<string, unknown> },
        ): Promise<unknown[]> => {
          const name = typeof entity === 'string' ? entity : (entity.name ?? '');
          const where = options?.where ?? {};
          const companyId = where.company_id !== undefined ? Number(where.company_id) : null;

          if (name === 'Product') {
            const ids = idsOf(where, 'id');
            return Promise.resolve(
              this.products
                .filter((p) => ids.includes(p.id))
                .filter((p) => companyId === null || p.company_id === companyId)
                .map((p) => ({ ...p, id: String(p.id), parent_id: p.parent_id })),
            );
          }
          if (name === 'Packaging') {
            const ids = idsOf(where, 'id');
            return Promise.resolve(
              this.packagings
                .filter((pk) => ids.includes(pk.id))
                .filter((pk) => companyId === null || pk.company_id === companyId)
                .map((pk) => ({ ...pk, id: String(pk.id) })),
            );
          }
          if (name === 'ComboComponent') {
            let rows = this.recipe.filter((r) => companyId === null || r.company_id === companyId);
            if (where.combo_product_id !== undefined) {
              const ids = idsOf(where, 'combo_product_id');
              rows = rows.filter((r) => ids.includes(r.combo_product_id));
            }
            if (where.component_product_id !== undefined) {
              const ids = idsOf(where, 'component_product_id');
              rows = rows.filter((r) => ids.includes(r.component_product_id));
            }
            return Promise.resolve(
              rows.map((r) => {
                const component = this.products.find((p) => p.id === r.component_product_id);
                return {
                  ...r,
                  id: String(r.id),
                  combo_product_id: String(r.combo_product_id),
                  component_product_id: String(r.component_product_id),
                  combo: this.products.find((p) => p.id === r.combo_product_id),
                  component: component
                    ? {
                        ...component,
                        packaging: this.packagings.find((pk) => pk.id === component.packaging_id),
                      }
                    : undefined,
                };
              }),
            );
          }
          return Promise.resolve([]);
        },
        insert: (_entity: unknown, row: Record<string, unknown>): Promise<unknown> => {
          this.recipe.push({
            id: this.nextRecipeId++,
            company_id: Number(row.company_id),
            combo_product_id: Number(row.combo_product_id),
            component_product_id: Number(row.component_product_id),
            quantity: Number(row.quantity),
          });
          return Promise.resolve({ identifiers: [] });
        },
        update: (
          _entity: unknown,
          criteria: Record<string, unknown>,
          patch: { quantity: number },
        ): Promise<unknown> => {
          const row = this.recipe.find((r) => String(r.id) === String(criteria.id));
          if (row) {
            row.quantity = patch.quantity;
          }
          return Promise.resolve({ affected: 1 });
        },
        delete: (_entity: unknown, criteria: Record<string, unknown>): Promise<unknown> => {
          const comboId = Number(criteria.combo_product_id);
          const companyId = Number(criteria.company_id);
          const keep = criteria.component_product_id;
          this.recipe = this.recipe.filter((r) => {
            if (r.combo_product_id !== comboId || r.company_id !== companyId) {
              return true;
            }
            if (keep === undefined) {
              return false;
            }
            return unwrapIds(keep).includes(r.component_product_id);
          });
          return Promise.resolve({ affected: 0 });
        },
      } as unknown as EntityManager;
    }
  }

  /** Maní (KILO x1000, $12.000) y uva pasa (KILO x1000, $20.000) + combo. */
  const seedBusiness = (): Harness => {
    const h = new Harness();
    h.seedPackaging(300, 1000);
    h.seedProduct({ id: 1, name: 'MANÍ CON SAL', cost: 12000, packaging_id: 300, stock: 5000 });
    h.seedProduct({ id: 2, name: 'UVA PASA', cost: 20000, packaging_id: 300, stock: 3000 });
    h.seedProduct({ id: 9, name: 'COMBO MIX', product_type: 'COMBO' });
    return h;
  };

  describe('resolveComboComponents — reglas de negocio', () => {
    it('resuelve el costo por componente y el total del combo', async () => {
      const h = seedBusiness();
      const components = await resolveComboComponents(h.manager, COMPANY, 9, [
        { component_product_id: 1, quantity: 25 },
        { component_product_id: 2, quantity: 30 },
      ]);

      expect(components.map((c) => c.cost)).toEqual([300, 600]);
      expect(comboCostFromComponents(components)).toBe(900);
    });

    it('rechaza una receta vacía', async () => {
      const h = seedBusiness();
      await expect(resolveComboComponents(h.manager, COMPANY, 9, [])).rejects.toThrow(
        'Un combo debe tener al menos un producto en su receta.',
      );
    });

    it('rechaza un componente repetido', async () => {
      const h = seedBusiness();
      await expect(
        resolveComboComponents(h.manager, COMPANY, 9, [
          { component_product_id: 1, quantity: 25 },
          { component_product_id: 1, quantity: 10 },
        ]),
      ).rejects.toThrow(/no puede aparecer dos veces/);
    });

    it('rechaza cantidad 0, negativa o no numérica', async () => {
      const h = seedBusiness();
      for (const quantity of [0, -5, Number.NaN]) {
        await expect(
          resolveComboComponents(h.manager, COMPANY, 9, [{ component_product_id: 1, quantity }]),
        ).rejects.toThrow('La cantidad de cada producto de la receta debe ser mayor que 0.');
      }
    });

    it('rechaza una cantidad que el redondeo a 4 decimales anula', async () => {
      const h = seedBusiness();
      await expect(
        resolveComboComponents(h.manager, COMPANY, 9, [
          { component_product_id: 1, quantity: 0.00001 },
        ]),
      ).rejects.toThrow(/máximo 4 decimales/);
    });

    it('redondea la cantidad a 4 decimales (precisión de la columna)', async () => {
      const h = seedBusiness();
      const [component] = await resolveComboComponents(h.manager, COMPANY, 9, [
        { component_product_id: 1, quantity: 25.123456 },
      ]);
      expect(component.quantity).toBe(25.1235);
    });

    it('rechaza que un combo se incluya a sí mismo', async () => {
      const h = seedBusiness();
      await expect(
        resolveComboComponents(h.manager, COMPANY, 9, [{ component_product_id: 9, quantity: 1 }]),
      ).rejects.toThrow('Un combo no puede incluirse a sí mismo en su receta.');
    });

    it('rechaza un COMBO como componente (sin anidamiento)', async () => {
      const h = seedBusiness();
      h.seedProduct({ id: 8, name: 'OTRO COMBO', product_type: 'COMBO' });
      await expect(
        resolveComboComponents(h.manager, COMPANY, 9, [{ component_product_id: 8, quantity: 1 }]),
      ).rejects.toThrow('"OTRO COMBO" es un combo. Un combo no puede contener otro combo.');
    });

    it('rechaza una PRESENTACIÓN como componente', async () => {
      const h = seedBusiness();
      h.seedProduct({ id: 3, name: 'MANÍ LIBRA', parent_id: 1, packaging_id: 300 });
      await expect(
        resolveComboComponents(h.manager, COMPANY, 9, [{ component_product_id: 3, quantity: 1 }]),
      ).rejects.toThrow('"MANÍ LIBRA" es una presentación. La receta solo admite productos base.');
    });

    it('rechaza un componente archivado', async () => {
      const h = seedBusiness();
      h.products[1].is_archived = true;
      await expect(
        resolveComboComponents(h.manager, COMPANY, 9, [{ component_product_id: 2, quantity: 1 }]),
      ).rejects.toThrow('Uno de los productos de la receta ya no existe o está archivado.');
    });

    it('MULTI-TENANT: no se puede meter en la receta un producto de OTRA company', async () => {
      const h = seedBusiness();
      h.seedProduct({ id: 77, company_id: OTRA_COMPANY, name: 'AJENO', cost: 1000 });
      await expect(
        resolveComboComponents(h.manager, COMPANY, 9, [{ component_product_id: 77, quantity: 1 }]),
      ).rejects.toThrow('Uno de los productos de la receta ya no existe o está archivado.');
    });

    it('todos los errores son BadRequestException (400, no 500)', async () => {
      const h = seedBusiness();
      await expect(resolveComboComponents(h.manager, COMPANY, 9, [])).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });
  });

  describe('syncComboComponents — alta, baja y cambio de cantidad', () => {
    const resolved = (id: number, quantity: number): ResolvedComboComponent => ({
      component_product_id: id,
      name: `P${id}`,
      quantity,
      component_cost: 0,
      component_packaging_value: null,
      cost: 0,
    });

    it('inserta la receta completa cuando no existía', async () => {
      const h = seedBusiness();
      await syncComboComponents(h.manager, COMPANY, 9, [resolved(1, 25), resolved(2, 30)]);

      expect(h.recipe.map((r) => [r.component_product_id, r.quantity])).toEqual([
        [1, 25],
        [2, 30],
      ]);
      expect(h.recipe.every((r) => r.company_id === COMPANY)).toBe(true);
    });

    it('actualiza in-place la cantidad que cambió, sin borrar la fila', async () => {
      const h = seedBusiness();
      h.seedRecipe(9, 1, 25);
      const originalId = h.recipe[0].id;

      await syncComboComponents(h.manager, COMPANY, 9, [resolved(1, 40)]);

      expect(h.recipe).toHaveLength(1);
      expect(h.recipe[0].id).toBe(originalId);
      expect(h.recipe[0].quantity).toBe(40);
    });

    it('borra los componentes que el usuario quitó', async () => {
      const h = seedBusiness();
      h.seedRecipe(9, 1, 25);
      h.seedRecipe(9, 2, 30);

      await syncComboComponents(h.manager, COMPANY, 9, [resolved(1, 25)]);

      expect(h.recipe.map((r) => r.component_product_id)).toEqual([1]);
    });

    it('MULTI-TENANT: no toca la receta de un combo homónimo de otra company', async () => {
      const h = seedBusiness();
      h.seedRecipe(9, 1, 5, OTRA_COMPANY);
      h.seedRecipe(9, 2, 30, COMPANY);

      await syncComboComponents(h.manager, COMPANY, 9, [resolved(1, 25)]);

      const ajena = h.recipe.filter((r) => r.company_id === OTRA_COMPANY);
      expect(ajena.map((r) => [r.component_product_id, r.quantity])).toEqual([[1, 5]]);
    });

    it('clearComboComponents borra solo la receta del combo y company indicados', async () => {
      const h = seedBusiness();
      h.seedRecipe(9, 1, 25, COMPANY);
      h.seedRecipe(9, 2, 30, OTRA_COMPANY);

      await clearComboComponents(h.manager, COMPANY, 9);

      expect(h.recipe.map((r) => r.company_id)).toEqual([OTRA_COMPANY]);
    });
  });

  describe('assertNotUsedInActiveCombos — guard de archivado/conversión', () => {
    it('no hace nada si el producto no participa en ninguna receta', async () => {
      const h = seedBusiness();
      await expect(
        assertNotUsedInActiveCombos(h.manager, COMPANY, [1], 'archivar'),
      ).resolves.toBeUndefined();
    });

    it('bloquea y nombra el combo que quedaría huérfano', async () => {
      const h = seedBusiness();
      h.seedRecipe(9, 1, 25);
      await expect(
        assertNotUsedInActiveCombos(h.manager, COMPANY, [1], 'archivar'),
      ).rejects.toThrow(
        'No se puede archivar: el producto forma parte de el combo "COMBO MIX". Quítalo de la receta primero.',
      );
    });

    it('el verbo de la acción viaja en el mensaje', async () => {
      const h = seedBusiness();
      h.seedRecipe(9, 1, 25);
      await expect(
        assertNotUsedInActiveCombos(h.manager, COMPANY, [1], 'convertir en combo'),
      ).rejects.toThrow(/No se puede convertir en combo:/);
    });

    it('IGNORA los combos archivados (su receta ya no opera)', async () => {
      const h = seedBusiness();
      h.products[2].is_archived = true;
      h.seedRecipe(9, 1, 25);
      await expect(
        assertNotUsedInActiveCombos(h.manager, COMPANY, [1], 'archivar'),
      ).resolves.toBeUndefined();
    });

    it('MULTI-TENANT: un combo de otra company no bloquea el archivado aquí', async () => {
      const h = seedBusiness();
      h.seedRecipe(9, 1, 25, OTRA_COMPANY);
      await expect(
        assertNotUsedInActiveCombos(h.manager, COMPANY, [1], 'archivar'),
      ).resolves.toBeUndefined();
    });

    it('findCombosUsingComponents agrupa por componente', async () => {
      const h = seedBusiness();
      h.seedRecipe(9, 1, 25);
      h.seedRecipe(9, 2, 30);
      const usage = await findCombosUsingComponents(h.manager, COMPANY, [1, 2]);
      expect(usage.get(1)).toEqual([{ id: 9, name: 'COMBO MIX' }]);
      expect(usage.get(2)).toEqual([{ id: 9, name: 'COMBO MIX' }]);
    });

    it('lista vacía ⇒ ni consulta ni error', async () => {
      const h = seedBusiness();
      await expect(
        assertNotUsedInActiveCombos(h.manager, COMPANY, [], 'archivar'),
      ).resolves.toBeUndefined();
    });
  });
});
