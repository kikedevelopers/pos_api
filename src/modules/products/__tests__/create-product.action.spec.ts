import { Test, type TestingModule } from '@nestjs/testing';
import { DataSource } from 'typeorm';

import { buildPriceRow, CreateProductAction } from '../actions/create-product.action';
import type { Product } from '../entities/product.entity';
import { ProductType } from '../entities/product.entity';
import type { ProductPrice } from '../entities/product-price.entity';

/**
 * Tests unitarios de `CreateProductAction` y del helper `buildPriceRow`.
 *
 * Cubrimos:
 *   - `buildPriceRow` recalcula `profit` y `margin` con Big.js
 *     (anti-bug: no usa `number` directo). Casos canon §2.5 CLAUDE.md.
 *   - `company_id` se asigna desde el contexto, NUNCA del DTO.
 *   - El INSERT product + INSERT prices ocurren en la MISMA transacción.
 */
describe('buildPriceRow (helper)', () => {
  const fakeProduct = {
    id: '10',
    company_id: '42',
  } as unknown as Product;

  const actor = { id: 7, fullName: 'Kike' };

  it('calcula profit = sale_price - cost (anti-IEEE 754)', () => {
    const row = buildPriceRow({ sale_price: 10, iva_percentage: 0 }, fakeProduct, 2, actor);
    expect(row.profit).toBe(8);
  });

  it('calcula margin como % sobre sale_price (4 decimales)', () => {
    const row = buildPriceRow({ sale_price: 10, iva_percentage: 0 }, fakeProduct, 2, actor);
    // (10 - 2) / 10 * 100 = 80
    expect(row.margin).toBe(80);
  });

  it('margin = 0 cuando sale_price = 0 (evita división por cero)', () => {
    const row = buildPriceRow({ sale_price: 0, iva_percentage: 0 }, fakeProduct, 5, actor);
    expect(row.margin).toBe(0);
  });

  it('caso clásico de floating point: 0.1 + 0.2 con Big.js', () => {
    // sale_price = 0.3, cost = 0.1 → profit debería ser 0.2 exacto.
    // En JS native (0.3 - 0.1) === 0.19999999999999998. Big.js lo evita.
    const row = buildPriceRow({ sale_price: 0.3, iva_percentage: 0 }, fakeProduct, 0.1, actor);
    expect(row.profit).toBe(0.2);
  });

  it('asigna company_id desde el product (denormalizado coherente)', () => {
    const row = buildPriceRow({ sale_price: 10, iva_percentage: 0 }, fakeProduct, 2, actor);
    expect(row.company_id).toBe('42');
    expect(row.product_id).toBe('10');
  });

  it('default iva_percentage = 0 cuando ausente', () => {
    const row = buildPriceRow({ sale_price: 10 }, fakeProduct, 2, actor);
    expect(row.iva_percentage).toBe(0);
  });
});

describe('CreateProductAction', () => {
  let action: CreateProductAction;
  let createdInput: Partial<Product> | null;
  let insertedPrices: Array<Partial<ProductPrice>> | null;
  let transactionSpy: jest.Mock;

  beforeEach(async () => {
    createdInput = null;
    insertedPrices = null;

    const managerMock = {
      // `query` se usa por `assertPackagingBelongsToCompany`. Devuelve []
      // (no hay packaging → válido si no se envía).
      query: jest.fn(() => Promise.resolve([])),
      findOne: jest.fn(() => Promise.resolve(null)),
      create: jest.fn((_entity: unknown, input: Partial<Product>) => {
        createdInput = input;
        return { ...input, id: '100' } as Product;
      }),
      save: jest.fn(
        (_entity: unknown, product: Product): Promise<Product> =>
          Promise.resolve({
            ...product,
            id: '100',
            created_at: new Date('2026-05-12T14:30:00.000Z'),
            updated_at: new Date('2026-05-12T14:30:00.000Z'),
          }),
      ),
      insert: jest.fn((_entity: unknown, rows: Array<Partial<ProductPrice>>) => {
        insertedPrices = rows;
        return Promise.resolve({ identifiers: [], generatedMaps: [], raw: [] });
      }),
      findOneOrFail: jest.fn((_entity: unknown, opts: unknown) =>
        Promise.resolve({
          id: '100',
          name: 'X',
          company_id: '42',
          prices: insertedPrices ?? [],
          packaging: null,
          created_at: new Date('2026-05-12T14:30:00.000Z'),
          updated_at: new Date('2026-05-12T14:30:00.000Z'),
          ...(opts as object),
        } as unknown as Product),
      ),
    };

    transactionSpy = jest.fn(async <T>(cb: (m: typeof managerMock) => Promise<T>) =>
      cb(managerMock),
    );

    const dataSourceMock = { transaction: transactionSpy };

    const module: TestingModule = await Test.createTestingModule({
      providers: [CreateProductAction, { provide: DataSource, useValue: dataSourceMock }],
    }).compile();

    action = module.get(CreateProductAction);
  });

  it('asigna company_id desde el parámetro, NUNCA del DTO', async () => {
    await action.execute(
      {
        name: 'Coca-Cola 2L',
        cost: 2,
        prices: [{ sale_price: 5 }],
      },
      42,
      { id: 7, fullName: 'Kike' },
    );

    expect(createdInput?.company_id).toBe('42');
  });

  it('inicializa is_archived = false y show_in_pos = true por default', async () => {
    await action.execute({ name: 'X', cost: 1, prices: [{ sale_price: 2 }] }, 1, {
      id: 1,
      fullName: 'Owner',
    });

    expect(createdInput?.is_archived).toBe(false);
    expect(createdInput?.show_in_pos).toBe(true);
  });

  it('default product_type = SIMPLE si no viene en el DTO', async () => {
    await action.execute({ name: 'X', cost: 1, prices: [{ sale_price: 2 }] }, 1, {
      id: 1,
      fullName: 'Owner',
    });
    expect(createdInput?.product_type).toBe(ProductType.SIMPLE);
  });

  it('recalcula profit/margin de cada precio con Big.js', async () => {
    await action.execute(
      {
        name: 'Y',
        cost: 2,
        // El cliente envía hint profit/margin "erróneos"; el server los ignora.
        prices: [{ sale_price: 10, profit: 9999, margin: 9999 }],
      },
      1,
      { id: 1, fullName: 'Owner' },
    );

    expect(insertedPrices).toHaveLength(1);
    expect(insertedPrices?.[0]?.profit).toBe(8);
    expect(insertedPrices?.[0]?.margin).toBe(80);
  });

  it('ejecuta toda la creación dentro de UNA SOLA dataSource.transaction', async () => {
    await action.execute({ name: 'X', cost: 1, prices: [{ sale_price: 2 }] }, 1, {
      id: 1,
      fullName: 'Owner',
    });
    expect(transactionSpy).toHaveBeenCalledTimes(1);
  });
});
