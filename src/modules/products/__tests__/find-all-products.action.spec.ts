import { DataSource } from 'typeorm';

import { toProductResponseDto } from '../dto/product-response.dto';
import { FindAllProductsAction, sortParentsThenChildren } from '../actions/find-all-products.action';
import type { Product } from '../entities/product.entity';
import { ProductType } from '../entities/product.entity';

/**
 * Garantiza la EQUIVALENCIA byte-a-byte tras migrar el fetch a SQL crudo:
 *
 *   1. El objeto plano producido por el fetch contiene TODOS los campos que
 *      `toProductResponseDto` y `sortParentsThenChildren` consumen.
 *   2. El controller usa `id` (clave de Map) y `parent_id` (lookup) — deben
 *      ser del mismo tipo (`string`).
 *   3. `created_at`/`updated_at` deben ser `Date` (el mapper hace
 *      `.toISOString()`; el sort hace `.getTime()`).
 */

/** Fila cruda tal como la devuelve el driver `pg` (numeric/bigint → string). */
function rawRow(over: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: '10',
    name: 'Coca-Cola 2L',
    description: 'Bebida',
    product_type: ProductType.SIMPLE,
    parent_id: null,
    sku_code: 'SKU-1',
    bar_code: '7591001234567',
    packaging_id: '5',
    category_id: '3',
    cost: '2.50',
    stock: '10.0000',
    is_purchasable: false,
    image: null,
    show_in_pos: true,
    is_archived: false,
    created_by: 'Kike',
    updated_by: null,
    created_at: new Date('2026-05-12T14:30:00.000Z'),
    updated_at: new Date('2026-05-12T15:30:00.000Z'),
    packaging__id: '5',
    packaging__name: 'Caja x 12',
    packaging__value: '12.0000',
    category__id: '3',
    category__name: 'Bebidas',
    prices: [
      { id: 100, name: 'Detal', sale_price: 10.5, profit: 8, margin: 76.1905, iva_percentage: 0 },
    ],
    ...over,
  };
}

function makeAction(rows: Record<string, unknown>[]): FindAllProductsAction {
  const dataSource = {
    query: jest.fn().mockResolvedValue(rows),
  } as unknown as DataSource;
  return new FindAllProductsAction(dataSource);
}

describe('FindAllProductsAction (SQL crudo)', () => {
  it('produce objetos planos con TODOS los campos que toProductResponseDto consume', async () => {
    const action = makeAction([rawRow()]);
    const [product] = await action.execute(42, {});

    // El mapper del controller no debe romper ni perder campos.
    const dto = toProductResponseDto(product, null);

    expect(dto).toEqual({
      id: 10,
      name: 'Coca-Cola 2L',
      bar_code: '7591001234567',
      sku_code: 'SKU-1',
      description: 'Bebida',
      cost: 2.5,
      stock: 10,
      stock_display: 0.8333, // computeStockDisplay redondea a 4 decimales (Big.roundHalfUp).
      product_type: ProductType.SIMPLE,
      parent_id: null,
      packaging_id: 5,
      category_id: 3,
      image: null,
      show_in_pos: true,
      is_purchasable: false,
      is_archived: false,
      archived: false,
      created_by: 'Kike',
      updated_by: null,
      created_at: '2026-05-12T14:30:00.000Z',
      updated_at: '2026-05-12T15:30:00.000Z',
      packaging: { id: 5, name: 'Caja x 12', value: 12 },
      category: { id: 3, name: 'Bebidas' },
      prices: [
        { id: 100, name: 'Detal', sale_price: 10.5, profit: 8, margin: 76.1905, iva_percentage: 0 },
      ],
    });
  });

  it('packaging/category null cuando no hay join; prices vacío con COALESCE', async () => {
    const action = makeAction([
      rawRow({
        packaging__id: null,
        packaging__name: null,
        packaging__value: null,
        category__id: null,
        category__name: null,
        packaging_id: null,
        category_id: null,
        prices: [],
      }),
    ]);
    const [product] = await action.execute(42, {});
    const dto = toProductResponseDto(product, null);
    expect(dto.packaging).toBeNull();
    expect(dto.category).toBeNull();
    expect(dto.prices).toEqual([]);
  });

  it('id y parent_id quedan como string (compatibles con el Map del controller)', async () => {
    const action = makeAction([rawRow({ id: '10', parent_id: null })]);
    const [product] = await action.execute(42, {});
    expect(typeof product.id).toBe('string');
    expect(product.parent_id).toBeNull();

    const action2 = makeAction([rawRow({ id: '11', parent_id: '10' })]);
    const [child] = await action2.execute(42, {});
    expect(typeof child.parent_id).toBe('string');
    expect(child.parent_id).toBe('10');
  });

  it('created_at/updated_at son Date (soportan .getTime() y .toISOString())', async () => {
    const action = makeAction([rawRow()]);
    const [product] = await action.execute(42, {});
    expect(product.created_at).toBeInstanceOf(Date);
    expect(product.updated_at).toBeInstanceOf(Date);
    expect(() => product.created_at.getTime()).not.toThrow();
  });

  it('normaliza created_at cuando el driver devuelve string', async () => {
    const action = makeAction([rawRow({ created_at: '2026-05-12T14:30:00.000Z' })]);
    const [product] = await action.execute(42, {});
    expect(product.created_at).toBeInstanceOf(Date);
    expect(product.created_at.toISOString()).toBe('2026-05-12T14:30:00.000Z');
  });
});

describe('sortParentsThenChildren (intacta)', () => {
  function p(id: string, parentId: string | null, createdAt: string): Product {
    return {
      id,
      parent_id: parentId,
      created_at: new Date(createdAt),
    } as unknown as Product;
  }

  it('ordena padres por created_at DESC, cada uno seguido de sus hijos DESC', () => {
    const products = [
      p('1', null, '2026-01-01T00:00:00.000Z'),
      p('2', null, '2026-03-01T00:00:00.000Z'),
      p('3', '1', '2026-01-05T00:00:00.000Z'),
      p('4', '1', '2026-01-10T00:00:00.000Z'),
    ];
    const sorted = sortParentsThenChildren(products).map((x) => x.id);
    // Padre 2 (más nuevo), luego padre 1 + hijos (4 más nuevo, luego 3).
    expect(sorted).toEqual(['2', '1', '4', '3']);
  });

  it('conserva hijos huérfanos al final', () => {
    const products = [
      p('1', null, '2026-01-01T00:00:00.000Z'),
      p('9', '99', '2026-01-05T00:00:00.000Z'),
    ];
    const sorted = sortParentsThenChildren(products).map((x) => x.id);
    expect(sorted).toEqual(['1', '9']);
  });
});
