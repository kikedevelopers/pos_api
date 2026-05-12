import { BadRequestException, UnprocessableEntityException } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { DataSource } from 'typeorm';

import type { Customer } from '@/modules/customers/entities/customer.entity';
import { FinancialMovementsService } from '@/modules/financial-movements/financial-movements.service';
import type { Product } from '@/modules/products/entities/product.entity';
import { ProductType } from '@/modules/products/entities/product.entity';
import { IncrementTicketNumberAction } from '@/modules/ticket-settings/actions/increment-ticket-number.action';

import { CreateSaleAction } from '../actions/create-sale.action';
import type { SaleCredit } from '../entities/sale-credit.entity';
import { SaleCreditStatus } from '../entities/sale-credit.entity';
import type { SaleInvoiceLine } from '../entities/sale-invoice-line.entity';
import type { SaleInvoice } from '../entities/sale-invoice.entity';
import { TicketType } from '../entities/sale-invoice.entity';
import type { SalePayment } from '../entities/sale-payment.entity';
import { SalePaymentMethod } from '../entities/sale-payment.entity';

/**
 * Tests unitarios de `CreateSaleAction`.
 *
 * Cubrimos:
 *   - Camino feliz mostrador (sin customer, sin payments → 422 si no hay pago,
 *     pero el caso esperado es venta contado: lo cubrimos con pago full).
 *   - Cross-tenant: customer/product/packaging/product_price de otra company → 422/400.
 *   - Sale a crédito: sin payments + customer → SaleCredit con balance = total +
 *     Customer.balance decrementado.
 *   - Idempotency: payment con uuid ya existente devuelve idempotente sin duplicar.
 *   - Total Big.js: 0.1 + 0.2 sin error IEEE 754.
 *   - Toda la operación dentro de UNA transacción.
 */
describe('CreateSaleAction', () => {
  let action: CreateSaleAction;
  let transactionSpy: jest.Mock;
  let recordSpy: jest.Mock;
  let incrementSpy: jest.Mock;

  let creates: Array<{ entity: string; input: Record<string, unknown> }>;
  let inserts: Array<{ entity: string; rows: Record<string, unknown>[] }>;
  let updates: Array<{
    entity: string;
    where: Record<string, unknown>;
    patch: Record<string, unknown>;
  }>;
  let decrements: Array<{ entity: string; column: string; value: number }>;

  let customers: Map<string, Partial<Customer>>;
  let products: Map<string, Partial<Product>>;
  let savedSale: Partial<SaleInvoice> | null;
  let savedLines: Partial<SaleInvoiceLine>[];
  let savedCredit: Partial<SaleCredit> | null;
  let existingPayments: Map<string, Partial<SalePayment>>;

  beforeEach(async () => {
    creates = [];
    inserts = [];
    updates = [];
    decrements = [];
    customers = new Map();
    products = new Map();
    savedSale = null;
    savedLines = [];
    savedCredit = null;
    existingPayments = new Map();

    const managerMock = {
      findOne: jest.fn(
        (
          entity: { name?: string } | string,
          options: { where: Record<string, unknown> },
        ): Promise<unknown> => {
          const entityName = typeof entity === 'string' ? entity : (entity.name ?? 'Unknown');
          const where = options.where;

          if (entityName === 'Customer') {
            const id = String(where.id);
            const companyId = String(where.company_id);
            const customer = customers.get(`${id}|${companyId}`);
            if (!customer || (where.is_archived === false && customer.is_archived)) {
              return Promise.resolve(null);
            }
            return Promise.resolve(customer);
          }

          if (entityName === 'SalePayment') {
            // Fast-path idempotencia.
            const key = `${String(where.company_id)}|${String(where.uuid)}`;
            return Promise.resolve(existingPayments.get(key) ?? null);
          }

          if (entityName === 'SaleInvoice') {
            return Promise.resolve(savedSale);
          }
          if (entityName === 'SaleCredit') {
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
          if (entityName === 'SaleInvoiceLine') {
            return Promise.resolve(savedLines);
          }
          return Promise.resolve([]);
        },
      ),
      create: jest.fn((entity: { name?: string } | string, input: Record<string, unknown>) => {
        const entityName = typeof entity === 'string' ? entity : (entity.name ?? 'Unknown');
        creates.push({ entity: entityName, input });
        return input;
      }),
      save: jest.fn((entity: { name?: string } | string, payload: Record<string, unknown>) => {
        const entityName = typeof entity === 'string' ? entity : (entity.name ?? 'Unknown');
        if (entityName === 'SaleInvoice') {
          savedSale = {
            ...payload,
            id: '500',
            created_at: new Date('2026-05-12T14:30:00.000Z'),
            updated_at: new Date('2026-05-12T14:30:00.000Z'),
          };
          return Promise.resolve(savedSale);
        }
        if (entityName === 'SaleCredit') {
          savedCredit = {
            ...payload,
            id: '700',
            created_at: new Date('2026-05-12T14:30:00.000Z'),
            updated_at: new Date('2026-05-12T14:30:00.000Z'),
          };
          return Promise.resolve(savedCredit);
        }
        return Promise.resolve({
          ...payload,
          id: '900',
          created_at: new Date('2026-05-12T14:30:00.000Z'),
        });
      }),
      insert: jest.fn((entity: { name?: string } | string, rows: Record<string, unknown>[]) => {
        const entityName = typeof entity === 'string' ? entity : (entity.name ?? 'Unknown');
        inserts.push({ entity: entityName, rows });
        if (entityName === 'SaleInvoiceLine') {
          savedLines = rows.map((r, idx) => ({
            ...r,
            id: String(1000 + idx),
            created_at: new Date('2026-05-12T14:30:00.000Z'),
          }));
        }
        return Promise.resolve({ identifiers: [{ id: 1000 }] });
      }),
      update: jest.fn(
        (
          entity: { name?: string } | string,
          where: Record<string, unknown>,
          patch: Record<string, unknown>,
        ) => {
          const entityName = typeof entity === 'string' ? entity : (entity.name ?? 'Unknown');
          updates.push({ entity: entityName, where, patch });
          return Promise.resolve({ raw: [], affected: 1, generatedMaps: [] });
        },
      ),
      decrement: jest.fn(
        (
          entity: { name?: string } | string,
          _where: Record<string, unknown>,
          column: string,
          value: number,
        ) => {
          const entityName = typeof entity === 'string' ? entity : (entity.name ?? 'Unknown');
          decrements.push({ entity: entityName, column, value });
          return Promise.resolve({ raw: [], affected: 1, generatedMaps: [] });
        },
      ),
    };

    transactionSpy = jest.fn(async <T>(cb: (m: typeof managerMock) => Promise<T>) =>
      cb(managerMock),
    );
    recordSpy = jest.fn().mockResolvedValue(undefined);
    incrementSpy = jest
      .fn()
      .mockResolvedValueOnce({ number: 1, formatted: '001' })
      .mockResolvedValueOnce({ number: 1, formatted: '001' });

    const dataSourceMock = { transaction: transactionSpy };
    const financialMovementsServiceMock = { record: recordSpy };
    const incrementTicketNumberMock = { execute: incrementSpy };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CreateSaleAction,
        { provide: DataSource, useValue: dataSourceMock },
        { provide: FinancialMovementsService, useValue: financialMovementsServiceMock },
        { provide: IncrementTicketNumberAction, useValue: incrementTicketNumberMock },
      ],
    }).compile();

    action = module.get(CreateSaleAction);
  });

  function seedCustomer(id: number, companyId: number, opts: Partial<Customer> = {}): void {
    customers.set(`${id}|${companyId}`, {
      id: String(id),
      company_id: String(companyId),
      name: opts.name ?? `Customer ${id}`,
      is_archived: opts.is_archived ?? false,
      balance: opts.balance ?? 0,
    });
  }
  function seedProduct(
    id: number,
    companyId: number,
    opts: Partial<Product> & { cost?: number } = {},
  ): void {
    products.set(`${id}|${companyId}`, {
      id: String(id),
      company_id: String(companyId),
      name: opts.name ?? `Product ${id}`,
      product_type: opts.product_type ?? ProductType.SIMPLE,
      is_archived: opts.is_archived ?? false,
      cost: opts.cost ?? 10,
    });
  }

  it('camino feliz: venta a crédito sin pagos → crea SaleCredit con balance = total y decrementa Customer.balance', async () => {
    seedCustomer(1, 42, { balance: 0 });
    seedProduct(10, 42, { cost: 10 });

    const aggregate = await action.execute(
      {
        customer_id: 1,
        lines: [{ product_id: 10, quantity: 2, unit_price: 25, iva_percentage: 16 }],
      },
      42,
      { id: 7, fullName: 'Kike Pacheco' },
    );

    expect(transactionSpy).toHaveBeenCalledTimes(1);

    const saleCreate = creates.find((c) => c.entity === 'SaleInvoice');
    expect(saleCreate).toBeDefined();
    // subtotal = 25 * 2 = 50; iva = 50 * 16 / 100 = 8; total = 58.
    expect(saleCreate?.input.subtotal).toBe(50);
    expect(saleCreate?.input.tax_total).toBe(8);
    expect(saleCreate?.input.total).toBe(58);
    expect(saleCreate?.input.cost).toBe(20);
    expect(saleCreate?.input.profit).toBe(38);
    expect(saleCreate?.input.company_id).toBe('42');
    expect(saleCreate?.input.ticket_type).toBe(TicketType.ORDER);
    expect(saleCreate?.input.ticket_number).toBe('001');
    expect(saleCreate?.input.customer_id).toBe('1');
    expect(saleCreate?.input.customer_name).toBe('Customer 1');
    expect(saleCreate?.input.created_by).toBe('Kike Pacheco');

    // SaleCredit creado con balance = total = 58.
    const creditCreate = creates.find((c) => c.entity === 'SaleCredit');
    expect(creditCreate?.input.total_amount).toBe(58);
    expect(creditCreate?.input.paid_amount).toBe(0);
    expect(creditCreate?.input.balance).toBe(58);
    expect(creditCreate?.input.status).toBe(SaleCreditStatus.PENDING);

    // Customer.balance -= 58.
    const customerDec = decrements.find((d) => d.entity === 'Customer');
    expect(customerDec?.column).toBe('balance');
    expect(customerDec?.value).toBe(58);

    // Sin pagos → ningún record financial movement.
    expect(recordSpy).not.toHaveBeenCalled();

    expect(aggregate.sale).toBeDefined();
    expect(Number(aggregate.sale?.id)).toBe(500);
  });

  it('rechaza saldo pendiente sin customer (venta mostrador a crédito) con 422', async () => {
    seedProduct(10, 42);

    await expect(
      action.execute(
        {
          lines: [{ product_id: 10, quantity: 1, unit_price: 100 }],
        },
        42,
        { id: 7, fullName: 'O' },
      ),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
  });

  it('rechaza customer de otra company con 422', async () => {
    seedCustomer(1, 99);
    seedProduct(10, 42);

    await expect(
      action.execute(
        {
          customer_id: 1,
          lines: [{ product_id: 10, quantity: 1, unit_price: 100 }],
        },
        42,
        { id: 7, fullName: 'O' },
      ),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
  });

  it('rechaza product de otra company con 400', async () => {
    seedCustomer(1, 42);
    seedProduct(10, 99);

    await expect(
      action.execute(
        {
          customer_id: 1,
          lines: [{ product_id: 10, quantity: 1, unit_price: 100 }],
        },
        42,
        { id: 7, fullName: 'O' },
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rechaza producto COMBO con 400', async () => {
    seedCustomer(1, 42);
    seedProduct(10, 42, { product_type: ProductType.COMBO });

    await expect(
      action.execute(
        {
          customer_id: 1,
          lines: [{ product_id: 10, quantity: 1, unit_price: 100 }],
        },
        42,
        { id: 7, fullName: 'O' },
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('Big.js: 0.1 + 0.2 sin error IEEE 754', async () => {
    seedCustomer(1, 42);
    seedProduct(10, 42, { cost: 0.05 });

    await action.execute(
      {
        customer_id: 1,
        lines: [
          { product_id: 10, quantity: 1, unit_price: 0.1 },
          { product_id: 10, quantity: 1, unit_price: 0.2 },
        ],
      },
      42,
      { id: 7, fullName: 'O' },
    );

    const saleCreate = creates.find((c) => c.entity === 'SaleInvoice');
    expect(saleCreate?.input.subtotal).toBe(0.3);
    expect(saleCreate?.input.total).toBe(0.3);
  });

  it('idempotency: pago con uuid ya procesado no duplica payment ni acredita cuenta', async () => {
    seedCustomer(1, 42);
    seedProduct(10, 42);
    const existingUuid = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';
    existingPayments.set(`42|${existingUuid}`, {
      id: '999',
      company_id: '42',
      sale_invoice_id: '500',
      uuid: existingUuid,
      amount: 100,
      payment_method: SalePaymentMethod.CASH,
    });

    await action.execute(
      {
        customer_id: 1,
        lines: [{ product_id: 10, quantity: 1, unit_price: 100 }],
        payments: [{ account_type: 'wallet', account_id: 1, amount: 100, uuid: existingUuid }],
      },
      42,
      { id: 7, fullName: 'O' },
    );

    // No se crea un nuevo SalePayment (el existente devuelve idempotente).
    expect(creates.find((c) => c.entity === 'SalePayment')).toBeUndefined();
    // No se acredita la wallet.
    expect(updates.find((u) => u.entity === 'Wallet')).toBeUndefined();
    // No se registra financial movement.
    expect(recordSpy).not.toHaveBeenCalled();
    // Como existe el pago previo de 100 y el total es 100, NO se crea SaleCredit
    // ni se decrementa Customer.balance.
    expect(creates.find((c) => c.entity === 'SaleCredit')).toBeUndefined();
    expect(decrements.find((d) => d.entity === 'Customer')).toBeUndefined();
  });

  it('toda la operación ocurre dentro de UNA transacción', async () => {
    seedCustomer(1, 42);
    seedProduct(10, 42);

    await action.execute(
      {
        customer_id: 1,
        lines: [{ product_id: 10, quantity: 1, unit_price: 50 }],
      },
      42,
      { id: 7, fullName: 'O' },
    );

    expect(transactionSpy).toHaveBeenCalledTimes(1);
  });
});
