import { BadRequestException } from '@nestjs/common';
import Big from 'big.js';
import { In, Not, type EntityManager } from 'typeorm';

import { Packaging } from '@/modules/packagings/entities/packaging.entity';

import { ComboComponent } from '../entities/combo-component.entity';
import { Product, ProductType } from '../entities/product.entity';

import {
  computeComboCost,
  computeComboStock,
  computeComponentCost,
  type ComboComponentCostInput,
} from './combo-costing';

/**
 * Producto COMBO — validación, persistencia de la receta y costeo.
 * Espejo de `placepos/src/main/database/comboOperations.ts`, con `company_id`
 * en TODA query (multi-tenant).
 *
 * Reglas de negocio (validadas en el servidor; el formulario es solo la primera
 * línea de defensa):
 *
 *   1. La receta debe tener al menos UN componente.
 *   2. Cada componente es un producto BASE (`parent_id IS NULL`) activo de la
 *      MISMA company. Una presentación no puede ser componente: su stock vive
 *      en el padre, así que apuntar al padre es equivalente y sin ambigüedad.
 *   3. Un COMBO no puede ser componente de otro COMBO (sin anidamiento).
 *   4. Un combo no puede llevarse a sí mismo.
 *   5. Un componente aparece una sola vez por combo.
 *   6. `quantity > 0`, en la unidad MÍNIMA del componente.
 *   7. Un COMBO nunca tiene `parent_id` ni empaque, ni es comprable.
 *
 * Los errores de negocio se lanzan como `BadRequestException` (400) — el
 * cliente PlacePos los muestra tal cual en el formulario.
 */

/** Componente tal como llega del formulario. */
export interface ComboComponentInput {
  component_product_id: number;
  /** Cantidad en la unidad MÍNIMA del componente. */
  quantity: number;
}

/** Componente ya resuelto contra la BD, con lo necesario para costear. */
export interface ResolvedComboComponent {
  component_product_id: number;
  name: string;
  quantity: number;
  component_cost: number;
  component_packaging_value: number | null;
  /** Aporte de este componente al costo del combo (redondeado a 2). */
  cost: number;
}

function toCostInput(c: ResolvedComboComponent): ComboComponentCostInput {
  return {
    component_cost: c.component_cost,
    component_packaging_value: c.component_packaging_value,
    quantity: c.quantity,
  };
}

/**
 * Normaliza y valida la FORMA del input antes de tocar la BD: ids válidos,
 * cantidades positivas y finitas, sin duplicados y al menos un componente.
 */
function normalizeComponentInputs(inputs: ComboComponentInput[]): ComboComponentInput[] {
  if (!Array.isArray(inputs) || inputs.length === 0) {
    throw new BadRequestException('Un combo debe tener al menos un producto en su receta.');
  }

  const seen = new Set<number>();
  return inputs.map((input) => {
    const id = Number(input?.component_product_id);
    if (!Number.isInteger(id) || id <= 0) {
      throw new BadRequestException('Hay un producto inválido en la receta del combo.');
    }
    if (seen.has(id)) {
      throw new BadRequestException(
        'Un mismo producto no puede aparecer dos veces en la receta. Suma las cantidades en una sola línea.',
      );
    }
    seen.add(id);

    const quantity = Number(input?.quantity);
    if (!Number.isFinite(quantity) || quantity <= 0) {
      throw new BadRequestException(
        'La cantidad de cada producto de la receta debe ser mayor que 0.',
      );
    }
    // numeric(15,4): con más decimales Postgres redondearía y una cantidad como
    // 0,00001 se guardaría como 0, violando el CHECK y devolviendo al usuario el
    // error crudo del driver. Se redondea aquí y se rechaza si el redondeo la
    // anula.
    const rounded = Number(new Big(quantity).round(4, Big.roundHalfUp).toString());
    if (rounded <= 0) {
      throw new BadRequestException(
        'La cantidad de cada producto de la receta debe ser mayor que 0 (máximo 4 decimales).',
      );
    }
    return { component_product_id: id, quantity: rounded };
  });
}

/**
 * Resuelve los componentes contra la BD aplicando todas las reglas de negocio y
 * devuelve, por componente, su costo resuelto y su aporte al combo.
 *
 * `comboId` es el id del combo que se está guardando (null al crear): se usa
 * para impedir la auto-referencia.
 */
export async function resolveComboComponents(
  manager: EntityManager,
  companyId: number,
  comboId: number | null,
  inputs: ComboComponentInput[],
): Promise<ResolvedComboComponent[]> {
  const normalized = normalizeComponentInputs(inputs);
  const ids = normalized.map((i) => i.component_product_id);

  if (comboId !== null && ids.includes(comboId)) {
    throw new BadRequestException('Un combo no puede incluirse a sí mismo en su receta.');
  }

  const products = await manager.find(Product, {
    where: { id: In(ids.map(String)), company_id: String(companyId) },
    select: {
      id: true,
      name: true,
      cost: true,
      parent_id: true,
      packaging_id: true,
      product_type: true,
      is_archived: true,
    },
  });
  const byId = new Map(products.map((p) => [Number(p.id), p]));

  for (const id of ids) {
    const product = byId.get(id);
    if (!product || product.is_archived) {
      throw new BadRequestException(
        'Uno de los productos de la receta ya no existe o está archivado.',
      );
    }
    if (product.product_type === ProductType.COMBO) {
      throw new BadRequestException(
        `"${product.name}" es un combo. Un combo no puede contener otro combo.`,
      );
    }
    if (product.parent_id !== null && product.parent_id !== undefined) {
      throw new BadRequestException(
        `"${product.name}" es una presentación. La receta solo admite productos base.`,
      );
    }
  }

  const packagingValues = await loadPackagingValues(
    manager,
    companyId,
    products
      .map((p) => p.packaging_id)
      .filter((id): id is string => id !== null && id !== undefined),
  );

  return normalized.map((input) => {
    const product = byId.get(input.component_product_id) as Product;
    const packagingValue =
      product.packaging_id !== null && product.packaging_id !== undefined
        ? (packagingValues.get(String(product.packaging_id)) ?? null)
        : null;
    const resolved: ResolvedComboComponent = {
      component_product_id: Number(product.id),
      name: product.name,
      quantity: input.quantity,
      component_cost: Number(product.cost),
      component_packaging_value: packagingValue,
      cost: 0,
    };
    resolved.cost = computeComponentCost(toCostInput(resolved));
    return resolved;
  });
}

/** Costo total del combo a partir de sus componentes ya resueltos. */
export function comboCostFromComponents(components: ResolvedComboComponent[]): number {
  return computeComboCost(components.map(toCostInput));
}

async function loadPackagingValues(
  manager: EntityManager,
  companyId: number,
  packagingIds: string[],
): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  const unique = [...new Set(packagingIds)];
  if (unique.length === 0) {
    return map;
  }
  const rows = await manager.find(Packaging, {
    where: { id: In(unique), company_id: String(companyId) },
    select: { id: true, value: true },
  });
  for (const row of rows) {
    const value = Number(row.value);
    if (Number.isFinite(value) && value > 0) {
      map.set(String(row.id), value);
    }
  }
  return map;
}

/**
 * Sincroniza la receta persistida con la del formulario: borra las líneas que
 * el usuario quitó, actualiza las cantidades que cambiaron e inserta las
 * nuevas. Debe correr DENTRO de la transacción del caller.
 */
export async function syncComboComponents(
  manager: EntityManager,
  companyId: number,
  comboId: number,
  components: ResolvedComboComponent[],
): Promise<void> {
  const keepIds = components.map((c) => String(c.component_product_id));

  await manager.delete(ComboComponent, {
    company_id: String(companyId),
    combo_product_id: String(comboId),
    component_product_id: Not(In(keepIds)),
  });

  const existing = await manager.find(ComboComponent, {
    where: { company_id: String(companyId), combo_product_id: String(comboId) },
    select: { id: true, component_product_id: true, quantity: true },
  });
  const existingByComponent = new Map(
    existing.map((row) => [String(row.component_product_id), row]),
  );

  for (const component of components) {
    const current = existingByComponent.get(String(component.component_product_id));
    if (!current) {
      await manager.insert(ComboComponent, {
        company_id: String(companyId),
        combo_product_id: String(comboId),
        component_product_id: String(component.component_product_id),
        quantity: component.quantity,
      });
      continue;
    }
    if (!new Big(Number(current.quantity)).eq(new Big(component.quantity))) {
      await manager.update(
        ComboComponent,
        { id: current.id, company_id: String(companyId) },
        { quantity: component.quantity },
      );
    }
  }
}

/** Borra la receta completa (al convertir un COMBO en otro tipo de producto). */
export async function clearComboComponents(
  manager: EntityManager,
  companyId: number,
  comboId: number,
): Promise<void> {
  await manager.delete(ComboComponent, {
    company_id: String(companyId),
    combo_product_id: String(comboId),
  });
}

/** Fila de receta enriquecida para las respuestas del API. */
export interface ComboComponentView {
  component_product_id: number;
  name: string;
  quantity: number;
  cost: number;
  packaging: { id: number; name: string; value: number } | null;
  component_stock: number;
}

/**
 * Carga las recetas de varios combos de una sola vez (evita N+1 en el listado).
 * Devuelve un mapa `combo_product_id → componentes`.
 */
export async function loadComboComponentsByCombo(
  manager: EntityManager,
  companyId: number,
  comboIds: number[],
): Promise<Map<number, ComboComponentView[]>> {
  const result = new Map<number, ComboComponentView[]>();
  const unique = [...new Set(comboIds)];
  if (unique.length === 0) {
    return result;
  }

  const rows = await manager.find(ComboComponent, {
    where: {
      company_id: String(companyId),
      combo_product_id: In(unique.map(String)),
    },
    relations: { component: { packaging: true } },
    order: { id: 'ASC' },
  });

  for (const row of rows) {
    const component = row.component;
    // Un componente archivado no puede aportar stock ni costo: dejarlo contar
    // mostraría un combo "armable" con un producto fuera del catálogo.
    if (!component || component.is_archived) {
      continue;
    }
    const packaging = component.packaging;
    const packagingValue = packaging ? Number(packaging.value) : null;
    const view: ComboComponentView = {
      component_product_id: Number(row.component_product_id),
      name: component.name,
      quantity: Number(row.quantity),
      cost: computeComponentCost({
        component_cost: Number(component.cost),
        component_packaging_value: packagingValue,
        quantity: Number(row.quantity),
      }),
      packaging: packaging
        ? { id: Number(packaging.id), name: packaging.name, value: Number(packaging.value) }
        : null,
      component_stock: Number(component.stock),
    };
    const list = result.get(Number(row.combo_product_id)) ?? [];
    list.push(view);
    result.set(Number(row.combo_product_id), list);
  }
  return result;
}

/** Stock DERIVADO del combo a partir de su receta ya cargada. */
export function comboStockFromComponents(components: ComboComponentView[]): number {
  return computeComboStock(
    components.map((c) => ({ component_stock: c.component_stock, quantity: c.quantity })),
  );
}

/**
 * Recalcula el `cost` de un combo a partir del costo VIGENTE de sus
 * componentes. Devuelve `null` si el combo no tiene receta.
 */
export async function recomputeComboCost(
  manager: EntityManager,
  companyId: number,
  comboId: number,
): Promise<number | null> {
  const rows = await manager.find(ComboComponent, {
    where: { company_id: String(companyId), combo_product_id: String(comboId) },
    relations: { component: { packaging: true } },
  });
  if (rows.length === 0) {
    return null;
  }
  return computeComboCost(
    rows.map((row) => ({
      component_cost: Number(row.component?.cost ?? 0),
      component_packaging_value: row.component?.packaging
        ? Number(row.component.packaging.value)
        : null,
      quantity: Number(row.quantity),
    })),
  );
}

/**
 * COMBOS ACTIVOS que usan alguno de estos productos como componente. Base de
 * los guards de archivado/conversión y de la propagación de costo.
 */
export async function findCombosUsingComponents(
  manager: EntityManager,
  companyId: number,
  componentIds: number[],
): Promise<Map<number, { id: number; name: string }[]>> {
  const result = new Map<number, { id: number; name: string }[]>();
  const unique = [...new Set(componentIds)];
  if (unique.length === 0) {
    return result;
  }

  const rows = await manager.find(ComboComponent, {
    where: {
      company_id: String(companyId),
      component_product_id: In(unique.map(String)),
    },
    relations: { combo: true },
  });
  for (const row of rows) {
    if (!row.combo || row.combo.is_archived) {
      continue;
    }
    const key = Number(row.component_product_id);
    const list = result.get(key) ?? [];
    list.push({ id: Number(row.combo.id), name: row.combo.name });
    result.set(key, list);
  }
  return result;
}

/**
 * Guard: impide dejar huérfana la receta de un combo activo. Se usa al archivar
 * productos y al convertir un base en presentación (dejaría de ser un base y su
 * stock pasaría a vivir en otro producto).
 */
export async function assertNotUsedInActiveCombos(
  manager: EntityManager,
  companyId: number,
  productIds: number[],
  action: string,
): Promise<void> {
  const usage = await findCombosUsingComponents(manager, companyId, productIds);
  if (usage.size === 0) {
    return;
  }
  const comboNames = [
    ...new Set(
      Array.from(usage.values())
        .flat()
        .map((combo) => combo.name),
    ),
  ];
  throw new BadRequestException(
    `No se puede ${action}: el producto forma parte de ${
      comboNames.length === 1 ? 'el combo' : 'los combos'
    } ${comboNames.map((n) => `"${n}"`).join(', ')}. Quítalo de la receta primero.`,
  );
}

/** POJO de producto extendido con su receta, que consume `toProductResponseDto`. */
export interface ProductWithComboComponents {
  components?: ComboComponentView[] | null;
}

/**
 * Adjunta la receta a cada producto COMBO de una lista, en su sitio.
 *
 * TODO listado que mapee con `toProductResponseDto` DEBE pasar por aquí: sin la
 * receta, `stock_display` de un combo sale 0 — que no es "dato ausente" sino
 * dato FALSO (el mismo combo saldría correcto por `GET /inventory` y agotado
 * por categoría).
 *
 * Una consulta por company DUEÑA (normalmente una; dos si una sucursal ve
 * combos compartidos por el principal). No-op sin combos: ni una query.
 */
export async function attachComboComponentsTo(
  manager: EntityManager,
  products: Product[],
  fallbackCompanyId: number,
): Promise<void> {
  const combos = products.filter((p) => p.product_type === ProductType.COMBO);
  if (combos.length === 0) {
    return;
  }

  const byCombo = await loadComboRecipes(
    manager,
    combos.map((combo) => ({
      id: Number(combo.id),
      owner_company_id: (combo as unknown as { owner_company_id?: number }).owner_company_id,
      company_id: combo.company_id,
    })),
    fallbackCompanyId,
  );

  for (const combo of combos) {
    (combo as Product & ProductWithComboComponents).components =
      byCombo.get(Number(combo.id)) ?? [];
  }
}

/** Lo mínimo que hace falta para localizar la receta de un combo. */
export interface ComboOwnerRef {
  id: number;
  /** Company DUEÑA (el principal si el combo es compartido). */
  owner_company_id?: number | null;
  company_id?: string | number | null;
}

/**
 * Carga las recetas de una lista de combos AGRUPANDO por company dueña.
 *
 * Existe separada de `attachComboComponentsTo` porque no todos los consumidores
 * tienen entidades `Product`: el listado del POS trabaja con filas planas de SQL
 * crudo y necesita exactamente el mismo agrupamiento. Duplicarlo abriría la
 * puerta a que una vista calcule el stock de un combo compartido contra la
 * company equivocada (y lo muestre agotado).
 *
 * Una consulta por company dueña — normalmente una; dos si una sucursal ve
 * combos compartidos por el principal.
 */
export async function loadComboRecipes(
  manager: EntityManager,
  combos: readonly ComboOwnerRef[],
  fallbackCompanyId: number,
): Promise<Map<number, ComboComponentView[]>> {
  const byCombo = new Map<number, ComboComponentView[]>();
  if (combos.length === 0) {
    return byCombo;
  }

  const idsByOwner = new Map<number, number[]>();
  for (const combo of combos) {
    const owner = Number(combo.owner_company_id ?? combo.company_id ?? fallbackCompanyId);
    const list = idsByOwner.get(owner) ?? [];
    list.push(Number(combo.id));
    idsByOwner.set(owner, list);
  }

  for (const [ownerCompanyId, ids] of idsByOwner.entries()) {
    const loaded = await loadComboComponentsByCombo(manager, ownerCompanyId, ids);
    for (const [comboId, components] of loaded.entries()) {
      byCombo.set(comboId, components);
    }
  }
  return byCombo;
}
