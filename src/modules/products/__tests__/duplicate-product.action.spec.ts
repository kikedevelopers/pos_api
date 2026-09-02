import { NotFoundException } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { DataSource } from 'typeorm';

import { Packaging } from '@/modules/packagings/entities/packaging.entity';
import { ProductImagesService } from '@/modules/product-images/product-images.service';

import { DuplicateProductAction } from '../actions/duplicate-product.action';
import { ComboComponent } from '../entities/combo-component.entity';
import { Product, ProductType } from '../entities/product.entity';
import { ProductPrice } from '../entities/product-price.entity';

/**
 * Tests unitarios de `DuplicateProductAction` (POST /inventory/:id/duplicate).
 *
 * El contrato que fijamos aquí:
 *   - Se copia TODO menos `sku_code`, `bar_code` (únicos) y `stock` (0).
 *   - El nombre lleva el sufijo COPIA, numerado si ya existe.
 *   - Una presentación conserva su `parent_id` (sigue colgando del mismo base).
 *   - Los precios se copian en orden, con profit/margin recalculados.
 *   - Un COMBO copia su receta y deriva el costo de ella.
 *   - Un producto de otra company no existe → 404 (anti cross-tenant).
 */

const ACTOR = { id: 7, fullName: 'Kike Pacheco' };
const COMPANY_ID = 42;

interface Harness {
  action: DuplicateProductAction;
  /** Payload que se pasó a `manager.create(Product, …)`. */
  createdInput: () => Partial<Product>;
  /** Filas insertadas en `product_prices`. */
  insertedPrices: () => Array<Partial<ProductPrice>>;
  /** Filas insertadas en `combo_components`. */
  insertedComponents: () => Array<Partial<ComboComponent>>;
  transactionCount: () => number;
  /** Argumentos con los que se pidió copiar el ARCHIVO de la imagen. */
  imageCopyCalls: () => Array<{
    sourceImage: string | null;
    targetProductId: number;
    targetCompanyId: number;
  }>;
}

interface HarnessOptions {
  /** Producto de origen. `null` simula "no existe / es de otra company". */
  source: Partial<Product> | null;
  /** Nombres YA ocupados en el catálogo (match case-insensible). */
  takenNames?: string[];
  /** Precios del producto de origen, en orden de creación. */
  prices?: Array<Partial<ProductPrice>>;
  /** Receta persistida del combo de origen. */
  recipe?: Array<{ component_product_id: string; quantity: number }>;
  /** Productos base que la receta referencia. */
  components?: Array<Partial<Product>>;
  /** Empaques que los componentes referencian. */
  packagings?: Array<{ id: string; value: number }>;
}

async function buildHarness(options: HarnessOptions): Promise<Harness> {
  const taken = new Set((options.takenNames ?? []).map((n) => n.trim().toLowerCase()));
  let createdInput: Partial<Product> = {};
  const insertedPrices: Array<Partial<ProductPrice>> = [];
  const insertedComponents: Array<Partial<ComboComponent>> = [];
  let candidateName = '';
  // La receta se lee dos veces: la del ORIGEN y, dentro de
  // `syncComboComponents`, la del DESTINO (que arranca vacía).
  let recipeReads = 0;

  const managerMock = {
    findOne: jest.fn((entity: unknown) =>
      Promise.resolve(entity === Product ? (options.source as Product | null) : null),
    ),
    getRepository: jest.fn(() => ({
      createQueryBuilder: () => {
        const qb = {
          select: () => qb,
          where: () => qb,
          andWhere: (_sql: string, params?: { name?: string }) => {
            if (params?.name !== undefined) {
              candidateName = params.name;
            }
            return qb;
          },
          limit: () => qb,
          getOne: () =>
            Promise.resolve(taken.has(candidateName.trim().toLowerCase()) ? { id: '999' } : null),
        };
        return qb;
      },
    })),
    find: jest.fn((entity: unknown): Promise<unknown[]> => {
      if (entity === ProductPrice) {
        return Promise.resolve(options.prices ?? []);
      }
      if (entity === ComboComponent) {
        recipeReads += 1;
        return Promise.resolve(recipeReads === 1 ? (options.recipe ?? []) : []);
      }
      if (entity === Product) {
        return Promise.resolve(options.components ?? []);
      }
      if (entity === Packaging) {
        return Promise.resolve(options.packagings ?? []);
      }
      return Promise.resolve([]);
    }),
    create: jest.fn((_entity: unknown, input: Partial<Product>) => {
      createdInput = input;
      return { ...input } as Product;
    }),
    save: jest.fn((_entity: unknown, product: Product) =>
      Promise.resolve({
        ...product,
        id: '100',
        created_at: new Date('2026-05-12T14:30:00.000Z'),
        updated_at: new Date('2026-05-12T14:30:00.000Z'),
      }),
    ),
    insert: jest.fn((entity: unknown, rows: unknown) => {
      if (entity === ProductPrice) {
        insertedPrices.push(...(rows as Array<Partial<ProductPrice>>));
      }
      if (entity === ComboComponent) {
        insertedComponents.push(rows as Partial<ComboComponent>);
      }
      return Promise.resolve({ identifiers: [], generatedMaps: [], raw: [] });
    }),
    update: jest.fn(() => Promise.resolve({ affected: 0, generatedMaps: [], raw: [] })),
    delete: jest.fn(() => Promise.resolve({ affected: 0, raw: [] })),
  };

  const transactionSpy = jest.fn(async <T>(cb: (m: typeof managerMock) => Promise<T>) =>
    cb(managerMock),
  );

  // Doble del servicio de imágenes: devuelve la ruta NUEVA que tendría la
  // copia del archivo en el bucket.
  const copyTo = jest.fn(
    (params: { sourceImage: string | null; targetProductId: number; targetCompanyId: number }) =>
      Promise.resolve(`inventory_items/${params.targetCompanyId}/${params.targetProductId}-cp.png`),
  );

  const module: TestingModule = await Test.createTestingModule({
    providers: [
      DuplicateProductAction,
      { provide: DataSource, useValue: { transaction: transactionSpy } },
      { provide: ProductImagesService, useValue: { copyTo } },
    ],
  }).compile();

  return {
    action: module.get(DuplicateProductAction),
    createdInput: () => createdInput,
    insertedPrices: () => insertedPrices,
    insertedComponents: () => insertedComponents,
    transactionCount: () => transactionSpy.mock.calls.length,
    imageCopyCalls: () => copyTo.mock.calls.map(([params]) => params),
  };
}

/** Producto BASE de referencia para los casos felices. */
const BASE_SOURCE: Partial<Product> = {
  id: '7',
  company_id: String(COMPANY_ID),
  name: 'ARROZ DIANA',
  description: 'Arroz blanco de primera',
  product_type: ProductType.SIMPLE,
  parent_id: null,
  sku_code: 'SKU-001',
  bar_code: '7701234567890',
  packaging_id: '3',
  category_id: '5',
  cost: 41500,
  stock: 120,
  image: 'inventory_items/42/7-abc123.png',
  show_in_pos: true,
  is_purchasable: true,
  is_archived: false,
  hash: 'hash-del-original',
  cloned_from_company_id: null,
};

describe('DuplicateProductAction · qué se copia', () => {
  it('nombra la copia "<NOMBRE> COPIA" cuando el nombre está libre', async () => {
    const h = await buildHarness({ source: BASE_SOURCE });
    await h.action.execute(7, COMPANY_ID, ACTOR);
    expect(h.createdInput().name).toBe('ARROZ DIANA COPIA');
  });

  it('numera la copia cuando "COPIA" ya existe', async () => {
    const h = await buildHarness({ source: BASE_SOURCE, takenNames: ['ARROZ DIANA COPIA'] });
    await h.action.execute(7, COMPANY_ID, ACTOR);
    expect(h.createdInput().name).toBe('ARROZ DIANA COPIA 2');
  });

  it('NO copia el SKU ni el código de barras (son únicos)', async () => {
    const h = await buildHarness({ source: BASE_SOURCE });
    await h.action.execute(7, COMPANY_ID, ACTOR);
    expect(h.createdInput().sku_code).toBeNull();
    expect(h.createdInput().bar_code).toBeNull();
  });

  it('la copia arranca con stock 0 aunque el original tenga existencias', async () => {
    const h = await buildHarness({ source: BASE_SOURCE });
    await h.action.execute(7, COMPANY_ID, ACTOR);
    expect(h.createdInput().stock).toBe(0);
  });

  it('hereda costo, categoría, empaque, descripción y flags', async () => {
    const h = await buildHarness({ source: BASE_SOURCE });
    await h.action.execute(7, COMPANY_ID, ACTOR);
    expect(h.createdInput()).toMatchObject({
      cost: 41500,
      category_id: '5',
      packaging_id: '3',
      description: 'Arroz blanco de primera',
      show_in_pos: true,
      is_purchasable: true,
      product_type: ProductType.SIMPLE,
      is_archived: false,
    });
  });

  it('la fila nace SIN ruta de imagen: el archivo se copia después del commit', async () => {
    const h = await buildHarness({ source: BASE_SOURCE });
    await h.action.execute(7, COMPANY_ID, ACTOR);
    // Copiar el string dejaría dos productos apuntando al MISMO objeto: quitar
    // la imagen en uno borraría la del otro.
    expect(h.createdInput().image).toBeNull();
  });

  it('duplica el ARCHIVO de la imagen a una ruta propia de la copia', async () => {
    const h = await buildHarness({ source: BASE_SOURCE });
    const copy = await h.action.execute(7, COMPANY_ID, ACTOR);

    expect(h.imageCopyCalls()).toEqual([
      {
        sourceImage: 'inventory_items/42/7-abc123.png',
        targetProductId: 100,
        targetCompanyId: COMPANY_ID,
      },
    ]);
    expect(copy.image).toBe('inventory_items/42/100-cp.png');
  });

  it('un original SIN imagen no dispara ninguna copia en el bucket', async () => {
    const h = await buildHarness({ source: { ...BASE_SOURCE, image: null } });
    const copy = await h.action.execute(7, COMPANY_ID, ACTOR);

    expect(h.imageCopyCalls()).toHaveLength(0);
    expect(copy.image).toBeNull();
  });

  it('respeta los flags en false del original (no los fuerza a default)', async () => {
    const h = await buildHarness({
      source: { ...BASE_SOURCE, show_in_pos: false, is_purchasable: false },
    });
    await h.action.execute(7, COMPANY_ID, ACTOR);
    expect(h.createdInput().show_in_pos).toBe(false);
    expect(h.createdInput().is_purchasable).toBe(false);
  });

  it('no arrastra el hash del original (ya no lo describe)', async () => {
    const h = await buildHarness({ source: BASE_SOURCE });
    await h.action.execute(7, COMPANY_ID, ACTOR);
    expect(h.createdInput().hash).toBeNull();
  });

  it('asigna company_id y autoría desde el contexto, no del origen', async () => {
    const h = await buildHarness({ source: { ...BASE_SOURCE, company_id: '999' } });
    await h.action.execute(7, COMPANY_ID, ACTOR);
    expect(h.createdInput().company_id).toBe('42');
    expect(h.createdInput().created_by).toBe('Kike Pacheco');
    expect(h.createdInput().created_by_id).toBe('7');
  });

  it('preserva el linaje de sucursal (cloned_from_company_id)', async () => {
    const h = await buildHarness({ source: { ...BASE_SOURCE, cloned_from_company_id: '3' } });
    await h.action.execute(7, COMPANY_ID, ACTOR);
    expect(h.createdInput().cloned_from_company_id).toBe('3');
  });

  it('todo ocurre dentro de UNA SOLA transacción', async () => {
    const h = await buildHarness({ source: BASE_SOURCE });
    await h.action.execute(7, COMPANY_ID, ACTOR);
    expect(h.transactionCount()).toBe(1);
  });
});

describe('DuplicateProductAction · presentaciones', () => {
  it('la copia de una presentación cuelga del MISMO producto base', async () => {
    const h = await buildHarness({
      source: { ...BASE_SOURCE, name: 'ARROZ DIANA X LIBRA', parent_id: '7' },
    });
    await h.action.execute(9, COMPANY_ID, ACTOR);
    expect(h.createdInput().parent_id).toBe('7');
    expect(h.createdInput().name).toBe('ARROZ DIANA X LIBRA COPIA');
  });
});

describe('DuplicateProductAction · precios', () => {
  it('copia los niveles en orden, con nombre e IVA, recalculando profit/margin', async () => {
    const h = await buildHarness({
      source: { ...BASE_SOURCE, cost: 2 },
      prices: [
        // profit/margin del origen están "sucios" a propósito: el server los
        // recalcula contra el costo de la copia.
        { name: 'Detal', sale_price: 10, profit: 9999, margin: 9999, iva_percentage: 19 },
        { name: 'Mayor', sale_price: 5, profit: 0, margin: 0, iva_percentage: 0 },
      ] as Array<Partial<ProductPrice>>,
    });
    await h.action.execute(7, COMPANY_ID, ACTOR);

    const inserted = h.insertedPrices();
    expect(inserted).toHaveLength(2);
    expect(inserted[0]).toMatchObject({
      name: 'Detal',
      sale_price: 10,
      profit: 8,
      margin: 80,
      iva_percentage: 19,
      product_id: '100',
      company_id: '42',
    });
    expect(inserted[1]).toMatchObject({ name: 'Mayor', sale_price: 5, profit: 3, margin: 60 });
  });

  it('un producto sin precios no dispara ningún INSERT de precios', async () => {
    const h = await buildHarness({ source: BASE_SOURCE, prices: [] });
    await h.action.execute(7, COMPANY_ID, ACTOR);
    expect(h.insertedPrices()).toHaveLength(0);
  });
});

describe('DuplicateProductAction · combos', () => {
  // MANÍ: cost 12.000 / empaque de 1000 ⇒ $12 por gramo. 25 g ⇒ 300.
  const COMBO_SOURCE: Partial<Product> = {
    ...BASE_SOURCE,
    name: 'COMBO MIX',
    product_type: ProductType.COMBO,
    packaging_id: null,
    cost: 300,
    is_purchasable: false,
  };

  const comboHarness = () =>
    buildHarness({
      source: COMBO_SOURCE,
      recipe: [{ component_product_id: '11', quantity: 25 }],
      components: [
        {
          id: '11',
          name: 'MANI CON SAL X KILO',
          cost: 12000,
          parent_id: null,
          packaging_id: '4',
          product_type: ProductType.SIMPLE,
          is_archived: false,
        },
      ],
      packagings: [{ id: '4', value: 1000 }],
    });

  it('copia la receta del combo al nuevo producto', async () => {
    const h = await comboHarness();
    await h.action.execute(7, COMPANY_ID, ACTOR);

    expect(h.insertedComponents()).toHaveLength(1);
    expect(h.insertedComponents()[0]).toMatchObject({
      company_id: '42',
      combo_product_id: '100',
      component_product_id: '11',
      quantity: 25,
    });
  });

  it('deriva el costo de la receta (no copia el costo congelado)', async () => {
    const h = await comboHarness();
    await h.action.execute(7, COMPANY_ID, ACTOR);
    expect(h.createdInput().cost).toBe(300);
  });

  it('rechaza duplicar un combo cuyo componente está archivado', async () => {
    const h = await buildHarness({
      source: COMBO_SOURCE,
      recipe: [{ component_product_id: '11', quantity: 25 }],
      components: [
        {
          id: '11',
          name: 'MANI CON SAL X KILO',
          cost: 12000,
          parent_id: null,
          packaging_id: '4',
          product_type: ProductType.SIMPLE,
          is_archived: true,
        },
      ],
      packagings: [{ id: '4', value: 1000 }],
    });

    await expect(h.action.execute(7, COMPANY_ID, ACTOR)).rejects.toThrow(
      /ya no existe o está archivado/,
    );
  });
});

describe('DuplicateProductAction · aislamiento', () => {
  it('404 si el producto no existe o pertenece a otra company', async () => {
    const h = await buildHarness({ source: null });
    await expect(h.action.execute(7, COMPANY_ID, ACTOR)).rejects.toBeInstanceOf(NotFoundException);
  });
});
