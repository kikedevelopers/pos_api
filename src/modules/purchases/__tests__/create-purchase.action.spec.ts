import { BadRequestException, UnprocessableEntityException } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { DataSource } from 'typeorm';

import type { Packaging } from '@/modules/packagings/entities/packaging.entity';
import type { Product } from '@/modules/products/entities/product.entity';
import { ProductType } from '@/modules/products/entities/product.entity';
import type { Supplier } from '@/modules/suppliers/entities/supplier.entity';

import { CreatePurchaseAction } from '../actions/create-purchase.action';
import type { PurchaseCredit } from '../entities/purchase-credit.entity';
import type { PurchaseLine } from '../entities/purchase-line.entity';
import type { Purchase } from '../entities/purchase.entity';
import { PurchaseStatus } from '../entities/purchase.entity';

/**
 * Tests unitarios de `CreatePurchaseAction`.
 *
 * Cubrimos:
 *   - Cross-tenant: supplier de otra company → 422.
 *   - Cross-tenant: product de otra company → 400.
 *   - Cálculo Big.js: subtotal = packaging_qty * packaging_price.
 *   - IVA: aplicado por línea, sumado al total.
 *   - Operación dentro de UNA transacción (§8.8 CLAUDE.md).
 *   - Generación de folio (mock del advisory lock).
 *   - Incremento de Supplier.accumulated_debt al final.
 *   - Creación atómica de PurchaseCredit con balance = total.
 */
describe('CreatePurchaseAction', () => {
  let action: CreatePurchaseAction;
  let transactionSpy: jest.Mock;
  let createdEntities: Array<{ entity: string; input: Record<string, unknown> }>;
  let insertedRows: Array<{ entity: string; rows: Record<string, unknown>[] }>;
  let supplierIncrements: Array<{ id: string; companyId: string; column: string; value: number }>;
  // Estado simulado de la "DB" mock.
  let suppliers: Map<string, Partial<Supplier>>;
  let products: Map<string, Partial<Product>>;
  let packagings: Map<string, Partial<Packaging>>;
  // Estado del último Purchase salvado, para que la relectura post-INSERT lo vea.
  let savedPurchase: Partial<Purchase> | null;
  let savedLines: Partial<PurchaseLine>[];
  let savedCredit: Partial<PurchaseCredit> | null;
  // Folio mockeado.
  const folioCounter = { current: 0 };

  beforeEach(async () => {
    createdEntities = [];
    insertedRows = [];
    supplierIncrements = [];
    suppliers = new Map();
    products = new Map();
    packagings = new Map();
    savedPurchase = null;
    savedLines = [];
    savedCredit = null;
    folioCounter.current = 0;

    const managerMock = {
      findOne: jest.fn(
        (
          entity: { name?: string } | string,
          options: { where: Record<string, unknown> },
        ): Promise<unknown> => {
          const entityName = typeof entity === 'string' ? entity : (entity.name ?? 'Unknown');
          const where = options.where;

          if (entityName === 'Supplier') {
            const id = String(where.id);
            const companyId = String(where.company_id);
            const supplier = suppliers.get(`${id}|${companyId}`);
            if (!supplier || (where.is_archived === false && supplier.is_archived)) {
              return Promise.resolve(null);
            }
            return Promise.resolve(supplier);
          }

          if (entityName === 'Purchase') {
            // Relectura post-INSERT del aggregate.
            return Promise.resolve(savedPurchase);
          }
          if (entityName === 'PurchaseCredit') {
            return Promise.resolve(savedCredit);
          }
          return Promise.resolve(null);
        },
      ),
      find: jest.fn(
        (
          entity: { name?: string } | string,
          options: { where: Record<string, unknown> },
        ): Promise<unknown[]> => {
          const entityName = typeof entity === 'string' ? entity : (entity.name ?? 'Unknown');
          const where = options.where;
          if (entityName === 'Product') {
            const companyId = String(where.company_id);
            const ids = (where.id as { _value: string[] })._value ?? [];
            return Promise.resolve(
              ids
                .map((id) => products.get(`${id}|${companyId}`))
                .filter((p): p is Partial<Product> => p !== undefined),
            );
          }
          if (entityName === 'Packaging') {
            const companyId = String(where.company_id);
            const ids = (where.id as { _value: string[] })._value ?? [];
            return Promise.resolve(
              ids
                .map((id) => packagings.get(`${id}|${companyId}`))
                .filter((p): p is Partial<Packaging> => p !== undefined),
            );
          }
          if (entityName === 'PurchaseLine') {
            return Promise.resolve(savedLines);
          }
          return Promise.resolve([]);
        },
      ),
      create: jest.fn((entity: { name?: string } | string, input: Record<string, unknown>) => {
        const entityName = typeof entity === 'string' ? entity : (entity.name ?? 'Unknown');
        createdEntities.push({ entity: entityName, input });
        return input;
      }),
      save: jest.fn((entity: { name?: string } | string, payload: Record<string, unknown>) => {
        const entityName = typeof entity === 'string' ? entity : (entity.name ?? 'Unknown');
        if (entityName === 'Purchase') {
          savedPurchase = {
            ...payload,
            id: '100',
            created_at: new Date('2026-05-12T14:30:00.000Z'),
            updated_at: new Date('2026-05-12T14:30:00.000Z'),
          };
          return Promise.resolve(savedPurchase);
        }
        if (entityName === 'PurchaseCredit') {
          savedCredit = {
            ...payload,
            id: '50',
            created_at: new Date('2026-05-12T14:30:00.000Z'),
            updated_at: new Date('2026-05-12T14:30:00.000Z'),
          };
          return Promise.resolve(savedCredit);
        }
        return Promise.resolve(payload);
      }),
      insert: jest.fn((entity: { name?: string } | string, rows: Record<string, unknown>[]) => {
        const entityName = typeof entity === 'string' ? entity : (entity.name ?? 'Unknown');
        insertedRows.push({ entity: entityName, rows });
        if (entityName === 'PurchaseLine') {
          savedLines = rows.map((r, idx) => ({
            ...r,
            id: String(200 + idx),
            created_at: new Date('2026-05-12T14:30:00.000Z'),
          }));
        }
        return Promise.resolve({ identifiers: [{ id: 100 }] });
      }),
      increment: jest.fn(
        (
          _entity: { name?: string } | string,
          where: Record<string, string>,
          column: string,
          value: number,
        ) => {
          supplierIncrements.push({
            id: where.id,
            companyId: where.company_id,
            column,
            value,
          });
          return Promise.resolve({ raw: [], affected: 1, generatedMaps: [] });
        },
      ),
      // Mock del QueryBuilder usado por `nextPurchaseNumber`. Devuelve `null` para
      // simular "no hay compra previa" → folio inicia en 001.
      createQueryBuilder: jest.fn(() => ({
        select: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        limit: jest.fn().mockReturnThis(),
        getRawOne: jest.fn().mockResolvedValue(null),
      })),
      // Advisory lock no-op en tests.
      query: jest.fn().mockResolvedValue([]),
    };

    transactionSpy = jest.fn(async <T>(cb: (m: typeof managerMock) => Promise<T>) =>
      cb(managerMock),
    );
    const dataSourceMock = { transaction: transactionSpy };

    const module: TestingModule = await Test.createTestingModule({
      providers: [CreatePurchaseAction, { provide: DataSource, useValue: dataSourceMock }],
    }).compile();

    action = module.get(CreatePurchaseAction);
  });

  function seedSupplier(id: number, companyId: number, opts: Partial<Supplier> = {}): void {
    suppliers.set(`${id}|${companyId}`, {
      id: String(id),
      company_id: String(companyId),
      legal_name: opts.legal_name ?? `Supplier ${id}`,
      is_archived: opts.is_archived ?? false,
      accumulated_debt: opts.accumulated_debt ?? 0,
    });
  }
  function seedProduct(id: number, companyId: number, opts: Partial<Product> = {}): void {
    products.set(`${id}|${companyId}`, {
      id: String(id),
      company_id: String(companyId),
      name: opts.name ?? `Product ${id}`,
      product_type: opts.product_type ?? ProductType.SIMPLE,
      is_archived: opts.is_archived ?? false,
      packaging_id: opts.packaging_id ?? null,
    });
  }

  it('camino feliz: crea Purchase + lines + PurchaseCredit + incrementa supplier debt', async () => {
    seedSupplier(1, 42);
    seedProduct(10, 42);

    await action.execute(
      {
        supplier_id: 1,
        lines: [
          {
            product_id: 10,
            packaging_qty: 10,
            unit_qty: 240,
            unit_price: 1.5,
            packaging_price: 36,
            iva_rate: 16,
          },
        ],
      },
      42,
      { id: 7, fullName: 'Kike Pacheco' },
    );

    // Purchase.create con totales correctos (Big.js).
    const purchaseCreate = createdEntities.find((c) => c.entity === 'Purchase');
    expect(purchaseCreate).toBeDefined();
    // subtotal = 10 * 36 = 360; iva = 360 * 16 / 100 = 57.6; total = 417.6.
    expect(purchaseCreate?.input.subtotal).toBe(360);
    expect(purchaseCreate?.input.iva_total).toBe(57.6);
    expect(purchaseCreate?.input.total).toBe(417.6);
    expect(purchaseCreate?.input.company_id).toBe('42');
    expect(purchaseCreate?.input.supplier_id).toBe('1');
    expect(purchaseCreate?.input.purchase_number).toBe('PUR-001');
    expect(purchaseCreate?.input.status).toBe(PurchaseStatus.PENDING);
    expect(purchaseCreate?.input.created_by).toBe('Kike Pacheco');
    expect(purchaseCreate?.input.created_by_id).toBe('7');

    // PurchaseLine batch insert.
    const lineInsert = insertedRows.find((r) => r.entity === 'PurchaseLine');
    expect(lineInsert).toBeDefined();
    expect(lineInsert?.rows).toHaveLength(1);
    expect(lineInsert?.rows[0]?.subtotal).toBe(360);
    expect(lineInsert?.rows[0]?.iva_amount).toBe(57.6);
    expect(lineInsert?.rows[0]?.total).toBe(417.6);

    // PurchaseCredit.create con balance = total.
    const creditCreate = createdEntities.find((c) => c.entity === 'PurchaseCredit');
    expect(creditCreate?.input.total_amount).toBe(417.6);
    expect(creditCreate?.input.paid_amount).toBe(0);
    expect(creditCreate?.input.balance).toBe(417.6);
    expect(creditCreate?.input.status).toBe('PENDING');

    // Supplier.accumulated_debt += total.
    expect(supplierIncrements).toHaveLength(1);
    expect(supplierIncrements[0]?.column).toBe('accumulated_debt');
    expect(supplierIncrements[0]?.value).toBe(417.6);
    expect(supplierIncrements[0]?.companyId).toBe('42');
  });

  it('rechaza supplier de otra company con 422', async () => {
    // supplier 1 existe en company 99, NO en 42.
    seedSupplier(1, 99);
    seedProduct(10, 42);

    await expect(
      action.execute(
        {
          supplier_id: 1,
          lines: [
            {
              product_id: 10,
              packaging_qty: 1,
              unit_qty: 1,
              unit_price: 1,
              packaging_price: 1,
            },
          ],
        },
        42,
        { id: 1, fullName: 'O' },
      ),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
  });

  it('rechaza product de otra company con 400', async () => {
    seedSupplier(1, 42);
    // product 10 NO existe en company 42.
    seedProduct(10, 99);

    await expect(
      action.execute(
        {
          supplier_id: 1,
          lines: [
            {
              product_id: 10,
              packaging_qty: 1,
              unit_qty: 1,
              unit_price: 1,
              packaging_price: 1,
            },
          ],
        },
        42,
        { id: 1, fullName: 'O' },
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rechaza producto COMBO con 400', async () => {
    seedSupplier(1, 42);
    seedProduct(10, 42, { product_type: ProductType.COMBO });

    await expect(
      action.execute(
        {
          supplier_id: 1,
          lines: [
            {
              product_id: 10,
              packaging_qty: 1,
              unit_qty: 1,
              unit_price: 1,
              packaging_price: 1,
            },
          ],
        },
        42,
        { id: 1, fullName: 'O' },
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rechaza línea con subtotal cero (packaging_price = 0 o qty * price = 0)', async () => {
    seedSupplier(1, 42);
    seedProduct(10, 42);

    await expect(
      action.execute(
        {
          supplier_id: 1,
          lines: [
            {
              product_id: 10,
              packaging_qty: 5,
              unit_qty: 5,
              unit_price: 0,
              packaging_price: 0, // subtotal = 0 → 422
            },
          ],
        },
        42,
        { id: 1, fullName: 'O' },
      ),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
  });

  it('toda la operación ocurre dentro de UNA transacción', async () => {
    seedSupplier(1, 42);
    seedProduct(10, 42);

    await action.execute(
      {
        supplier_id: 1,
        lines: [
          {
            product_id: 10,
            packaging_qty: 1,
            unit_qty: 1,
            unit_price: 1,
            packaging_price: 10,
          },
        ],
      },
      42,
      { id: 1, fullName: 'O' },
    );

    expect(transactionSpy).toHaveBeenCalledTimes(1);
  });

  it('cálculo Big.js: 0.1 + 0.2 sin error IEEE 754', async () => {
    seedSupplier(1, 42);
    seedProduct(10, 42);

    // Dos líneas que suman 0.3 exacto.
    await action.execute(
      {
        supplier_id: 1,
        lines: [
          {
            product_id: 10,
            packaging_qty: 1,
            unit_qty: 1,
            unit_price: 0.1,
            packaging_price: 0.1,
          },
          {
            product_id: 10,
            packaging_qty: 1,
            unit_qty: 1,
            unit_price: 0.2,
            packaging_price: 0.2,
          },
        ],
      },
      42,
      { id: 1, fullName: 'O' },
    );

    const purchaseCreate = createdEntities.find((c) => c.entity === 'Purchase');
    // Sin Big.js: 0.30000000000000004. Con Big.js: 0.30 redondeado a 2 dec.
    expect(purchaseCreate?.input.subtotal).toBe(0.3);
  });
});
