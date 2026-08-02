import { In, type EntityManager } from 'typeorm';

import { ComboComponent } from '../entities/combo-component.entity';
import { ProductType } from '../entities/product.entity';

import { resolveAccessibleProducts } from './accessible-products.helper';
import type { ComboRecipeSnapshot } from './adjust-inventory.helper';

/**
 * FIX #3 (snapshot de receta) — Resuelve, para un conjunto de `item_id`, la
 * receta VIGENTE de los que sean COMBO.
 *
 * Hermano de `resolvePackagingValues`. Se usa para CONGELAR la receta en la
 * línea (`sale_invoice_lines` / `credit_note_lines`) al comprometer las
 * unidades, de modo que el `DEDUCT` y su `RETURN` posterior expandan el combo
 * EXACTAMENTE igual (simetría) aunque la receta se edite entre medias.
 *
 * --------------------------------------------------------------------------
 * Snapshot TOLERANTE (no estricto)
 * --------------------------------------------------------------------------
 *
 * Este helper SOLO calcula el snapshot; NUNCA lanza. Los productos que no son
 * COMBO se OMITEN del Map → el caller persiste `combo_recipe = null`, que es lo
 * correcto: una línea de producto simple no tiene receta que congelar.
 *
 * Un COMBO **sí** entra siempre, aunque su receta esté vacía: `[]` significa "al
 * vender no tenía componentes" y debe devolver cero, no reexpandirse contra la
 * receta que exista el día de la anulación.
 *
 * --------------------------------------------------------------------------
 * Multi-tenancy / transacción
 * --------------------------------------------------------------------------
 *
 * - DEBE ejecutarse DENTRO de la transacción del caller (recibe su `manager`).
 * - La receta se lee en la company DUEÑA del combo. En cross-company (catálogo
 *   compartido por el principal) esa dueña NO es la company activa, así que el
 *   filtro sale de `resolveAccessibleProducts` — el mismo criterio del motor.
 *
 * @returns `Map<item_id, receta>` solo con los items que son COMBO.
 */
export async function resolveComboRecipes(
  manager: EntityManager,
  companyId: number,
  itemIds: number[],
  crossCompanyAccess = false,
): Promise<Map<number, ComboRecipeSnapshot>> {
  const result = new Map<number, ComboRecipeSnapshot>();
  const uniqueIds = [...new Set(itemIds.map((id) => Number(id)))];
  if (uniqueIds.length === 0) {
    return result;
  }

  // combo_product_id → company DUEÑA. Solo los COMBO llegan hasta aquí.
  const ownerByCombo = new Map<number, number>();
  const accessible = await resolveAccessibleProducts(manager, companyId, uniqueIds);
  for (const ref of accessible.values()) {
    // `productType` viaja como string en el ref accesible; el cast lo alinea
    // con el enum (mismo criterio que `adjust-inventory.helper`).
    if ((ref.productType as ProductType) !== ProductType.COMBO) {
      continue;
    }
    // En modo estricto, un combo de otra company no debe congelarse aquí.
    if (!crossCompanyAccess && ref.ownerCompanyId !== companyId) {
      continue;
    }
    ownerByCombo.set(ref.id, ref.ownerCompanyId);
    // Un combo sin receta queda igualmente con snapshot vacío (ver arriba).
    result.set(ref.id, []);
  }
  if (ownerByCombo.size === 0) {
    return result;
  }

  // Una condición por company dueña: normalmente una, dos si la sucursal ve
  // combos compartidos por el principal.
  const idsByOwner = new Map<number, number[]>();
  for (const [comboId, owner] of ownerByCombo.entries()) {
    const list = idsByOwner.get(owner) ?? [];
    list.push(comboId);
    idsByOwner.set(owner, list);
  }
  const rows = await manager.find(ComboComponent, {
    where: [...idsByOwner.entries()].map(([owner, ids]) => ({
      company_id: String(owner),
      combo_product_id: In(ids.map(String)),
    })),
    select: { combo_product_id: true, component_product_id: true, quantity: true },
    order: { id: 'ASC' },
  });

  for (const row of rows) {
    const comboId = Number(row.combo_product_id);
    const recipe = result.get(comboId);
    if (!recipe) {
      continue;
    }
    recipe.push({
      component_product_id: Number(row.component_product_id),
      quantity: Number(row.quantity),
    });
  }

  return result;
}
