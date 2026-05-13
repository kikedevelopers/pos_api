import { NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { DataSource } from 'typeorm';

import { FinancialMovementsService } from '@/modules/financial-movements/financial-movements.service';
import type { Product } from '@/modules/products/entities/product.entity';
import { ProductType } from '@/modules/products/entities/product.entity';
import type { SaleCredit } from '@/modules/sales/entities/sale-credit.entity';
import { SaleCreditStatus } from '@/modules/sales/entities/sale-credit.entity';
import type { SaleInvoiceLine } from '@/modules/sales/entities/sale-invoice-line.entity';
import type { SaleInvoice } from '@/modules/sales/entities/sale-invoice.entity';
import { TicketType } from '@/modules/sales/entities/sale-invoice.entity';
import type { SalePayment } from '@/modules/sales/entities/sale-payment.entity';
import { SalePaymentMethod } from '@/modules/sales/entities/sale-payment.entity';
import { IncrementTicketNumberAction } from '@/modules/ticket-settings/actions/increment-ticket-number.action';
import { TicketSettingType } from '@/modules/ticket-settings/entities/ticket-setting.entity';

import { CreateCreditNoteAction } from '../actions/create-credit-note.action';
import type { CreditNote } from '../entities/credit-note.entity';
import { NoteType, OperationType } from '../entities/credit-note.entity';

/**
 * Tests unitarios de `CreateCreditNoteAction`. Cubrimos:
 *
 *   1. Combinaciones ilegales (note_type x operation_type) → 422.
 *   2. Cross-tenant: venta de otra company → 404.
 *   3. Ticket ORDER (no SALE) → 422.
 *   4. FULL_VOID duplicado → 422.
 *   5. PARTIAL_VOID excede qty original → 422.
 *   6. Camino feliz FULL_VOID sin pagos: marca venta deleted, ajusta credit y customer.balance.
 *   7. Camino feliz FULL_VOID con pago en banco: revierte balance, FM EXPENSE, correction_source.
 *   8. Camino feliz PARTIAL_VOID: crea líneas, ajusta credit + customer.balance.
 *   9. Camino feliz ADDITION (DEBIT): aumenta credit y reduce customer.balance.
 *  10. Multi-tenant: venta + credit en company A, intento desde company B → 404.
 *  11. Big.js: 0.1 + 0.2 sin error IEEE 754.
 *  12. Toda dentro de UNA transacción.
 */
describe('CreateCreditNoteAction', () => {
  let action: CreateCreditNoteAction;
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
  let increments: Array<{ entity: string; column: string; value: number }>;
  let decrements: Array<{ entity: string; column: string; value: number }>;
  let saves: Array<{ entity: string; payload: Record<string, unknown> }>;
  let cashLogs: Array<Record<string, unknown>>;

  let sales: Map<string, Partial<SaleInvoice>>;
  let credits: Map<string, Partial<SaleCredit>>;
  let products: Map<string, Partial<Product>>;
  let originalLines: Map<string, Partial<SaleInvoiceLine>>;
  let payments: SalePayment[];
  let banks: Map<
    string,
    { id: string; company_id: string; name: string; balance: number; is_archived: boolean }
  >;
  let openRegister: { id: string; company_id: string } | null;
  let fullVoidCount: number;
  let partialVoidedByLine: Map<number, string>;
  let savedNote: Partial<CreditNote> | null;

  beforeEach(async () => {
    creates = [];
    inserts = [];
    updates = [];
    increments = [];
    decrements = [];
    saves = [];
    cashLogs = [];
    sales = new Map();
    credits = new Map();
    products = new Map();
    originalLines = new Map();
    payments = [];
    banks = new Map();
    openRegister = null;
    fullVoidCount = 0;
    partialVoidedByLine = new Map();
    savedNote = null;

    const managerMock = {
      findOne: jest.fn(
        (
          entity: { name?: string } | string,
          options: { where: Record<string, unknown> },
        ): Promise<unknown> => {
          const entityName = typeof entity === 'string' ? entity : (entity.name ?? 'Unknown');
          const where = options.where;

          if (entityName === 'SaleInvoice') {
            const key = `${String(where.id)}|${String(where.company_id)}`;
            const sale = sales.get(key);
            if (!sale) {
              return Promise.resolve(null);
            }
            if (where.is_deleted === false && sale.is_deleted) {
              return Promise.resolve(null);
            }
            return Promise.resolve(sale);
          }
          if (entityName === 'SaleCredit') {
            const key = `${String(where.sale_invoice_id)}|${String(where.company_id)}`;
            return Promise.resolve(credits.get(key) ?? null);
          }
          if (entityName === 'CreditNote') {
            return Promise.resolve(savedNote);
          }
          if (entityName === 'Bank') {
            const key = `${String(where.id)}|${String(where.company_id)}`;
            return Promise.resolve(banks.get(key) ?? null);
          }
          if (entityName === 'CashRegister') {
            if (
              openRegister &&
              openRegister.company_id === String(where.company_id) &&
              where.status === 'open'
            ) {
              return Promise.resolve(openRegister);
            }
            return Promise.resolve(null);
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
            const companyId = String(where.company_id);
            const saleId = String(where.sale_invoice_id);
            // si viene id IN [...] (carga puntual)
            if (where.id && typeof where.id === 'object' && '_value' in where.id) {
              const ids = (where.id as { _value: string[] })._value ?? [];
              return Promise.resolve(
                ids
                  .map((id) => originalLines.get(`${id}|${saleId}|${companyId}`))
                  .filter((l): l is Partial<SaleInvoiceLine> => l !== undefined),
              );
            }
            // listado completo de la venta (no se usa aquí).
            return Promise.resolve([]);
          }
          if (entityName === 'SalePayment') {
            return Promise.resolve(payments);
          }
          if (entityName === 'CreditNoteLine') {
            return Promise.resolve([]);
          }
          if (entityName === 'CorrectionSource') {
            return Promise.resolve([]);
          }
          return Promise.resolve([]);
        },
      ),
      count: jest.fn(
        (
          entity: { name?: string } | string,
          _options: { where: Record<string, unknown> },
        ): Promise<number> => {
          const entityName = typeof entity === 'string' ? entity : (entity.name ?? 'Unknown');
          if (entityName === 'CreditNote') {
            return Promise.resolve(fullVoidCount);
          }
          return Promise.resolve(0);
        },
      ),
      create: jest.fn((entity: { name?: string } | string, input: Record<string, unknown>) => {
        const entityName = typeof entity === 'string' ? entity : (entity.name ?? 'Unknown');
        creates.push({ entity: entityName, input });
        return input;
      }),
      save: jest.fn((entity: { name?: string } | string, payload: Record<string, unknown>) => {
        const entityName = typeof entity === 'string' ? entity : (entity.name ?? 'Unknown');
        saves.push({ entity: entityName, payload });
        if (entityName === 'CreditNote') {
          savedNote = {
            ...payload,
            id: '700',
            created_at: new Date('2026-05-12T14:30:00.000Z'),
            updated_at: new Date('2026-05-12T14:30:00.000Z'),
          };
          return Promise.resolve(savedNote);
        }
        if (entityName === 'CashRegisterLog') {
          cashLogs.push(payload);
          return Promise.resolve({ ...payload, id: '1000' });
        }
        if (entityName === 'CorrectionSource') {
          return Promise.resolve({ ...payload, id: '800' });
        }
        return Promise.resolve({ ...payload, id: '900' });
      }),
      insert: jest.fn((entity: { name?: string } | string, rows: Record<string, unknown>[]) => {
        const entityName = typeof entity === 'string' ? entity : (entity.name ?? 'Unknown');
        inserts.push({ entity: entityName, rows });
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
      increment: jest.fn(
        (
          entity: { name?: string } | string,
          _where: Record<string, unknown>,
          column: string,
          value: number,
        ) => {
          const entityName = typeof entity === 'string' ? entity : (entity.name ?? 'Unknown');
          increments.push({ entity: entityName, column, value });
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
      createQueryBuilder: jest.fn(() => {
        // Para sumPartialVoidedQuantitiesByLine — devolvemos rows desde el seed.
        const rows = Array.from(partialVoidedByLine.entries()).map(([originalLineId, qty]) => ({
          original_line_id: String(originalLineId),
          total_quantity: qty,
        }));
        const qb: Record<string, unknown> = {};
        const chain = (): typeof qb => qb;
        qb.innerJoin = chain;
        qb.select = chain;
        qb.addSelect = chain;
        qb.where = chain;
        qb.andWhere = chain;
        qb.groupBy = chain;
        qb.getRawMany = jest.fn(() => Promise.resolve(rows));
        // Métodos no usados pero defensivos:
        qb.orderBy = chain;
        qb.limit = chain;
        return qb;
      }),
      // Soportar tipos pasados como string para entidad
      getRepository: jest.fn(() => ({
        create: jest.fn(),
        save: jest.fn(),
      })),
    };

    transactionSpy = jest.fn(async <T>(cb: (m: typeof managerMock) => Promise<T>) =>
      cb(managerMock),
    );
    recordSpy = jest.fn().mockResolvedValue(undefined);
    incrementSpy = jest.fn().mockResolvedValue({ number: 1, formatted: 'NC-001' });

    const dataSourceMock = { transaction: transactionSpy };
    const financialMovementsServiceMock = { record: recordSpy };
    const incrementTicketNumberMock = { execute: incrementSpy };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CreateCreditNoteAction,
        { provide: DataSource, useValue: dataSourceMock },
        { provide: FinancialMovementsService, useValue: financialMovementsServiceMock },
        { provide: IncrementTicketNumberAction, useValue: incrementTicketNumberMock },
      ],
    }).compile();

    action = module.get(CreateCreditNoteAction);
  });

  function seedSale(
    id: number,
    companyId: number,
    opts: Partial<SaleInvoice> & { total?: number; customerId?: number } = {},
  ): void {
    sales.set(`${id}|${companyId}`, {
      id: String(id),
      company_id: String(companyId),
      ticket_type: opts.ticket_type ?? TicketType.SALE,
      ticket_number: '001',
      sale_number: '001',
      customer_id: opts.customerId !== undefined ? String(opts.customerId) : '1',
      customer_name: 'Customer 1',
      total: opts.total ?? 1000,
      is_deleted: opts.is_deleted ?? false,
    });
  }
  function seedCredit(
    saleId: number,
    companyId: number,
    opts: { total: number; paid: number; balance: number; status?: SaleCreditStatus },
  ): void {
    credits.set(`${saleId}|${companyId}`, {
      id: String(saleId * 10),
      sale_invoice_id: String(saleId),
      company_id: String(companyId),
      customer_id: '1',
      total_amount: opts.total,
      paid_amount: opts.paid,
      balance: opts.balance,
      status: opts.status ?? SaleCreditStatus.PENDING,
    });
  }
  function seedProduct(
    id: number,
    companyId: number,
    opts: { cost?: number; name?: string } = {},
  ): void {
    products.set(`${id}|${companyId}`, {
      id: String(id),
      company_id: String(companyId),
      name: opts.name ?? `Product ${id}`,
      product_type: ProductType.SIMPLE,
      is_archived: false,
      cost: opts.cost ?? 10,
    });
  }
  function seedOriginalLine(
    lineId: number,
    saleId: number,
    companyId: number,
    quantity: number,
  ): void {
    originalLines.set(`${lineId}|${saleId}|${companyId}`, {
      id: String(lineId),
      sale_invoice_id: String(saleId),
      company_id: String(companyId),
      quantity,
    });
  }
  function seedBank(id: number, companyId: number, balance: number): void {
    banks.set(`${id}|${companyId}`, {
      id: String(id),
      company_id: String(companyId),
      name: `Bank ${id}`,
      balance,
      is_archived: false,
    });
  }
  function seedPayment(
    saleId: number,
    companyId: number,
    accountType: 'bank' | 'wallet' | 'cash_register',
    accountId: number,
    amount: number,
  ): void {
    payments.push({
      id: String(payments.length + 1),
      company_id: String(companyId),
      sale_invoice_id: String(saleId),
      account_type: accountType,
      account_id: String(accountId),
      amount,
      change_amount: 0,
      payment_method: accountType === 'bank' ? SalePaymentMethod.TRANSFER : SalePaymentMethod.CASH,
      bank_id: null,
      bank_name: null,
      created_by: null,
      created_by_id: null,
      uuid: null,
      created_at: new Date(),
    } as SalePayment);
  }

  // ----------------------------------------------------------------------
  // 1. Combinación ilegal
  // ----------------------------------------------------------------------
  it('rechaza CREDIT + ADDITION (combinación ilegal) con 422', async () => {
    seedSale(1, 42);
    await expect(
      action.execute(
        {
          sale_invoice_id: 1,
          note_type: NoteType.CREDIT,
          operation_type: OperationType.ADDITION,
        },
        42,
        { id: 7, fullName: 'O' },
      ),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
  });

  it('rechaza DEBIT + FULL_VOID (combinación ilegal) con 422', async () => {
    seedSale(1, 42);
    await expect(
      action.execute(
        {
          sale_invoice_id: 1,
          note_type: NoteType.DEBIT,
          operation_type: OperationType.FULL_VOID,
        },
        42,
        { id: 7, fullName: 'O' },
      ),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
  });

  // ----------------------------------------------------------------------
  // 2. Cross-tenant: venta de otra company
  // ----------------------------------------------------------------------
  it('rechaza venta de otra company con 404 (multi-tenant)', async () => {
    seedSale(1, 99); // company 99, no 42
    await expect(
      action.execute(
        {
          sale_invoice_id: 1,
          note_type: NoteType.CREDIT,
          operation_type: OperationType.FULL_VOID,
        },
        42,
        { id: 7, fullName: 'O' },
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  // ----------------------------------------------------------------------
  // 3. Ticket ORDER (no SALE)
  // ----------------------------------------------------------------------
  it('rechaza nota sobre ORDER con 422', async () => {
    seedSale(1, 42, { ticket_type: TicketType.ORDER });
    await expect(
      action.execute(
        {
          sale_invoice_id: 1,
          note_type: NoteType.CREDIT,
          operation_type: OperationType.FULL_VOID,
        },
        42,
        { id: 7, fullName: 'O' },
      ),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
  });

  // ----------------------------------------------------------------------
  // 4. FULL_VOID duplicado
  // ----------------------------------------------------------------------
  it('rechaza FULL_VOID si ya existe una activa para la venta', async () => {
    seedSale(1, 42);
    fullVoidCount = 1;
    await expect(
      action.execute(
        {
          sale_invoice_id: 1,
          note_type: NoteType.CREDIT,
          operation_type: OperationType.FULL_VOID,
        },
        42,
        { id: 7, fullName: 'O' },
      ),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
  });

  // ----------------------------------------------------------------------
  // 5. PARTIAL_VOID excede qty original
  // ----------------------------------------------------------------------
  it('rechaza PARTIAL_VOID que excede la cantidad original con 422', async () => {
    seedSale(1, 42, { total: 100 });
    seedCredit(1, 42, { total: 100, paid: 0, balance: 100 });
    seedProduct(10, 42, { cost: 10 });
    seedOriginalLine(50, 1, 42, 2); // qty original = 2
    partialVoidedByLine.set(50, '1'); // ya anulamos 1
    // Nuevo intento: anular 2 más (total acumulado 3 > 2 disponibles).

    await expect(
      action.execute(
        {
          sale_invoice_id: 1,
          note_type: NoteType.CREDIT,
          operation_type: OperationType.PARTIAL_VOID,
          lines: [
            {
              original_line_id: 50,
              product_id: 10,
              quantity: 2,
              unit_price: 25,
            },
          ],
        },
        42,
        { id: 7, fullName: 'O' },
      ),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
  });

  // ----------------------------------------------------------------------
  // 6. Camino feliz FULL_VOID sin pagos
  // ----------------------------------------------------------------------
  it('FULL_VOID sin pagos: anula venta, ajusta credit, incrementa Customer.balance', async () => {
    seedSale(1, 42, { total: 1000, customerId: 5 });
    seedCredit(1, 42, { total: 1000, paid: 0, balance: 1000 });
    // sin payments seedeados → no se revierte nada.

    const result = await action.execute(
      {
        sale_invoice_id: 1,
        note_type: NoteType.CREDIT,
        operation_type: OperationType.FULL_VOID,
      },
      42,
      { id: 7, fullName: 'Kike Pacheco' },
    );

    // Folio CREDIT_NOTE pedido.
    expect(incrementSpy).toHaveBeenCalledWith(expect.anything(), 42, TicketSettingType.CREDIT_NOTE);

    // CreditNote creada con total = sale.total.
    const noteCreate = creates.find((c) => c.entity === 'CreditNote');
    expect(noteCreate?.input.total).toBe(1000);
    expect(noteCreate?.input.note_type).toBe(NoteType.CREDIT);
    expect(noteCreate?.input.operation_type).toBe(OperationType.FULL_VOID);
    expect(noteCreate?.input.company_id).toBe('42');
    expect(noteCreate?.input.sale_invoice_id).toBe('1');
    expect(noteCreate?.input.note_number).toBe('NC-001');

    // Venta marcada is_deleted = true.
    const saleUpdate = updates.find(
      (u) => u.entity === 'SaleInvoice' && u.patch.is_deleted === true,
    );
    expect(saleUpdate).toBeDefined();

    // SaleCredit reducido: total 0, balance 0, PAID.
    const creditUpdate = updates.find((u) => u.entity === 'SaleCredit');
    expect(creditUpdate?.patch.total_amount).toBe(0);
    expect(creditUpdate?.patch.balance).toBe(0);
    expect(creditUpdate?.patch.status).toBe(SaleCreditStatus.PAID);

    // Customer.balance += 1000.
    const customerInc = increments.find((i) => i.entity === 'Customer');
    expect(customerInc?.column).toBe('balance');
    expect(customerInc?.value).toBe(1000);

    // CorrectionSource = sale_credit.
    const csCreate = creates.find((c) => c.entity === 'CorrectionSource');
    expect(csCreate?.input.source_type).toBe('sale_credit');

    // Sin reverse de pagos.
    expect(recordSpy).not.toHaveBeenCalled();

    expect(result.note).toBeDefined();
    expect(Number(result.note?.id)).toBe(700);
  });

  // ----------------------------------------------------------------------
  // 7. Camino feliz FULL_VOID con pago en banco
  // ----------------------------------------------------------------------
  it('FULL_VOID con pago bancario: revierte balance bank, registra FM EXPENSE, correction_source=bank', async () => {
    seedSale(1, 42, { total: 500 });
    seedBank(1, 42, 5000);
    seedPayment(1, 42, 'bank', 1, 500);

    await action.execute(
      {
        sale_invoice_id: 1,
        note_type: NoteType.CREDIT,
        operation_type: OperationType.FULL_VOID,
      },
      42,
      { id: 7, fullName: 'Kike Pacheco' },
    );

    // Bank balance: 5000 - 500 = 4500.
    const bankUpdate = updates.find((u) => u.entity === 'Bank');
    expect(bankUpdate?.patch.balance).toBe(4500);

    // FM EXPENSE / CREDIT_NOTE_REFUND.
    expect(recordSpy).toHaveBeenCalledTimes(1);
    const calls = recordSpy.mock.calls as Array<[unknown, Record<string, unknown>]>;
    const fmArgs = calls[0]?.[1];
    if (!fmArgs) {
      throw new Error('Expected record call');
    }
    expect(fmArgs.movement_type).toBe('EXPENSE');
    expect(fmArgs.concept).toBe('CREDIT_NOTE_REFUND');
    expect(fmArgs.source_type).toBe('bank');
    // CRIT-1 auditoría: cuando la sale tiene customer_id, el reverso del
    // FinancialMovement destina al customer (no null). El CHECK
    // `chk_financial_movements_destination_consistency` exige que
    // destination_type y destination_id sean ambos NULL o ambos NOT NULL.
    expect(fmArgs.destination_type).toBe('external');
    expect(fmArgs.destination_id).toBe(1);
    expect(fmArgs.amount).toBe(500);

    // CorrectionSource = bank.
    const csCreate = creates.find((c) => c.entity === 'CorrectionSource');
    expect(csCreate?.input.source_type).toBe('bank');
    expect(csCreate?.input.source_id).toBe('1');
    expect(csCreate?.input.source_name).toBe('Bank 1');
  });

  // ----------------------------------------------------------------------
  // 8. Camino feliz PARTIAL_VOID
  // ----------------------------------------------------------------------
  it('PARTIAL_VOID: crea líneas, ajusta credit y Customer.balance', async () => {
    seedSale(1, 42, { total: 200 });
    seedCredit(1, 42, { total: 200, paid: 0, balance: 200 });
    seedProduct(10, 42, { cost: 10 });
    seedOriginalLine(50, 1, 42, 5);
    // partialVoidedByLine vacío → todo disponible.

    await action.execute(
      {
        sale_invoice_id: 1,
        note_type: NoteType.CREDIT,
        operation_type: OperationType.PARTIAL_VOID,
        lines: [
          {
            original_line_id: 50,
            product_id: 10,
            quantity: 2,
            unit_price: 25,
          },
        ],
      },
      42,
      { id: 7, fullName: 'O' },
    );

    // Líneas insertadas.
    const lineInsert = inserts.find((i) => i.entity === 'CreditNoteLine');
    expect(lineInsert?.rows.length).toBe(1);
    expect(lineInsert?.rows[0]?.quantity).toBe(2);
    expect(lineInsert?.rows[0]?.unit_price).toBe(25);
    expect(lineInsert?.rows[0]?.total).toBe(50);

    // Folio CREDIT_NOTE.
    expect(incrementSpy).toHaveBeenCalledWith(expect.anything(), 42, TicketSettingType.CREDIT_NOTE);

    // SaleCredit reducido: total 200-50=150, balance 200-50=150.
    const creditUpdate = updates.find((u) => u.entity === 'SaleCredit');
    expect(creditUpdate?.patch.total_amount).toBe(150);
    expect(creditUpdate?.patch.balance).toBe(150);

    // Customer.balance += 50.
    const customerInc = increments.find((i) => i.entity === 'Customer');
    expect(customerInc?.value).toBe(50);

    // SaleInvoice NO se marca deleted (PARTIAL_VOID).
    const saleUpdate = updates.find(
      (u) => u.entity === 'SaleInvoice' && u.patch.is_deleted === true,
    );
    expect(saleUpdate).toBeUndefined();
  });

  // ----------------------------------------------------------------------
  // 9. Camino feliz ADDITION
  // ----------------------------------------------------------------------
  it('ADDITION (DEBIT): aumenta credit y reduce Customer.balance', async () => {
    seedSale(1, 42, { total: 100 });
    seedCredit(1, 42, { total: 100, paid: 0, balance: 100 });
    seedProduct(10, 42);
    incrementSpy.mockResolvedValueOnce({ number: 1, formatted: 'ND-001' });

    await action.execute(
      {
        sale_invoice_id: 1,
        note_type: NoteType.DEBIT,
        operation_type: OperationType.ADDITION,
        lines: [{ product_id: 10, quantity: 1, unit_price: 30 }],
      },
      42,
      { id: 7, fullName: 'O' },
    );

    // Folio DEBIT_NOTE.
    expect(incrementSpy).toHaveBeenCalledWith(expect.anything(), 42, TicketSettingType.DEBIT_NOTE);

    // SaleCredit aumentado: total 100+30=130, balance 100+30=130.
    const creditUpdate = updates.find((u) => u.entity === 'SaleCredit');
    expect(creditUpdate?.patch.total_amount).toBe(130);
    expect(creditUpdate?.patch.balance).toBe(130);

    // Customer.balance -= 30 (más deuda).
    const customerDec = decrements.find((d) => d.entity === 'Customer');
    expect(customerDec?.value).toBe(30);

    // No correction_source (ADDITION no devuelve dinero).
    const csCreate = creates.find((c) => c.entity === 'CorrectionSource');
    expect(csCreate).toBeUndefined();

    // Sin FM (no toca caja).
    expect(recordSpy).not.toHaveBeenCalled();
  });

  // ----------------------------------------------------------------------
  // 10. Multi-tenant defensa explícita
  // ----------------------------------------------------------------------
  it('multi-tenant: venta en company A, intento desde company B → 404 sin tocar nada', async () => {
    seedSale(1, 100); // company 100
    await expect(
      action.execute(
        {
          sale_invoice_id: 1,
          note_type: NoteType.CREDIT,
          operation_type: OperationType.FULL_VOID,
        },
        200, // company 200
        { id: 7, fullName: 'O' },
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(creates.find((c) => c.entity === 'CreditNote')).toBeUndefined();
    expect(updates.find((u) => u.entity === 'SaleInvoice')).toBeUndefined();
    expect(recordSpy).not.toHaveBeenCalled();
  });

  // ----------------------------------------------------------------------
  // 11. Big.js precision
  // ----------------------------------------------------------------------
  it('Big.js: 0.1 + 0.2 sin error IEEE 754', async () => {
    seedSale(1, 42, { total: 1 });
    seedCredit(1, 42, { total: 1, paid: 0, balance: 1 });
    seedProduct(10, 42, { cost: 0 });
    seedOriginalLine(50, 1, 42, 1);
    seedOriginalLine(51, 1, 42, 1);

    await action.execute(
      {
        sale_invoice_id: 1,
        note_type: NoteType.CREDIT,
        operation_type: OperationType.PARTIAL_VOID,
        lines: [
          {
            original_line_id: 50,
            product_id: 10,
            quantity: 1,
            unit_price: 0.1,
          },
          {
            original_line_id: 51,
            product_id: 10,
            quantity: 1,
            unit_price: 0.2,
          },
        ],
      },
      42,
      { id: 7, fullName: 'O' },
    );

    const noteCreate = creates.find((c) => c.entity === 'CreditNote');
    // 0.1 + 0.2 = 0.3 con Big.js (no 0.30000000000000004).
    expect(noteCreate?.input.total).toBe(0.3);
  });

  // ----------------------------------------------------------------------
  // 12. UNA transacción
  // ----------------------------------------------------------------------
  it('toda la operación ocurre dentro de UNA transacción', async () => {
    seedSale(1, 42);
    seedCredit(1, 42, { total: 1000, paid: 0, balance: 1000 });
    await action.execute(
      {
        sale_invoice_id: 1,
        note_type: NoteType.CREDIT,
        operation_type: OperationType.FULL_VOID,
      },
      42,
      { id: 7, fullName: 'O' },
    );
    expect(transactionSpy).toHaveBeenCalledTimes(1);
  });
});
