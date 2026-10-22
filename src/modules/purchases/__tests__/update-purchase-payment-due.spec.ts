import { NotFoundException, UnprocessableEntityException, ValidationPipe } from '@nestjs/common';
import type { DataSource, Repository } from 'typeorm';

import type { FinancialMovementsService } from '@/modules/financial-movements/financial-movements.service';

import { UpdatePurchasePaymentDueAction } from '../actions/update-purchase-payment-due.action';
import { UpdatePurchaseAction } from '../actions/update-purchase.action';
import type { FindPurchaseAction } from '../actions/find-purchase.action';
import { UpdatePurchasePaymentDueDto } from '../dto/update-purchase-payment-due.dto';
import { UpdatePurchaseDto } from '../dto/update-purchase.dto';
import { PurchaseCreditStatus } from '../entities/purchase-credit.entity';
import type { Purchase } from '../entities/purchase.entity';

/**
 * Edición del plazo de pago de una compra:
 *   - `PATCH /purchases/:id/payment-due` (visor): solo toca `payment_due_at`.
 *   - `PUT /purchases/:id` (ventana de edición): `payment_due_date` opcional;
 *     omitido conserva el plazo, null lo quita.
 * Siempre vence al final del día en Bogotá y nunca en un día anterior a hoy.
 */
const entityName = (entity: unknown): string =>
  typeof entity === 'string' ? entity : ((entity as { name?: string }).name ?? 'Unknown');

describe('UpdatePurchasePaymentDueAction (PATCH /purchases/:id/payment-due)', () => {
  let updates: Array<{ where: Record<string, unknown>; values: Record<string, unknown> }>;
  let purchase: Partial<Purchase> | null;
  let credit: { status: PurchaseCreditStatus } | null;
  let findPurchase: jest.Mock;
  let action: UpdatePurchasePaymentDueAction;

  beforeEach(() => {
    updates = [];
    purchase = { id: '100', company_id: '42', is_deleted: false };
    credit = { status: PurchaseCreditStatus.PENDING };
    const manager = {
      findOne: jest.fn((entity: unknown, options: { where: Record<string, unknown> }) => {
        const name = entityName(entity);
        if (name === 'Purchase') {
          const where = options.where;
          const matches =
            purchase !== null &&
            where.company_id === purchase.company_id &&
            (where.is_deleted === undefined || where.is_deleted === purchase.is_deleted);
          return Promise.resolve(matches ? purchase : null);
        }
        if (name === 'PurchaseCredit') {
          return Promise.resolve(credit);
        }
        return Promise.resolve(null);
      }),
      update: jest.fn(
        (_entity: unknown, where: Record<string, unknown>, values: Record<string, unknown>) => {
          updates.push({ where, values });
          return Promise.resolve({ affected: 1 });
        },
      ),
    };
    findPurchase = jest.fn().mockResolvedValue({ purchase });
    action = new UpdatePurchasePaymentDueAction(
      { manager } as unknown as Repository<Purchase>,
      { execute: findPurchase } as unknown as FindPurchaseAction,
    );
  });

  it('fija el plazo al final del día elegido en Bogotá y devuelve el agregado', async () => {
    await action.execute(100, { payment_due_date: '2099-12-31' }, 42);

    expect(updates).toHaveLength(1);
    expect(updates[0]?.where).toEqual({ id: '100', company_id: '42' });
    expect(Object.keys(updates[0]?.values ?? {})).toEqual(['payment_due_at']);
    expect((updates[0]?.values.payment_due_at as Date).toISOString()).toBe(
      '2100-01-01T04:59:59.999Z',
    );
    expect(findPurchase).toHaveBeenCalledWith(100, 42);
  });

  it('null quita el plazo', async () => {
    await action.execute(100, { payment_due_date: null }, 42);
    expect(updates[0]?.values).toEqual({ payment_due_at: null });
  });

  it('rechaza un día anterior a hoy con 422 sin tocar la DB', async () => {
    await expect(action.execute(100, { payment_due_date: '2000-01-01' }, 42)).rejects.toThrow(
      'El plazo de pago no puede ser una fecha anterior a hoy',
    );
    expect(updates).toHaveLength(0);
  });

  it('compra de otra company → 404', async () => {
    await expect(action.execute(100, { payment_due_date: '2099-12-31' }, 7)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(updates).toHaveLength(0);
  });

  it('compra anulada → 404', async () => {
    purchase = { id: '100', company_id: '42', is_deleted: true };
    await expect(
      action.execute(100, { payment_due_date: '2099-12-31' }, 42),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('compra ya pagada no admite un plazo nuevo (422)', async () => {
    credit = { status: PurchaseCreditStatus.PAID };
    await expect(action.execute(100, { payment_due_date: '2099-12-31' }, 42)).rejects.toThrow(
      UnprocessableEntityException,
    );
    expect(updates).toHaveLength(0);
  });

  it('a una compra pagada sí se le puede quitar el plazo', async () => {
    credit = { status: PurchaseCreditStatus.PAID };
    await action.execute(100, { payment_due_date: null }, 42);
    expect(updates[0]?.values).toEqual({ payment_due_at: null });
  });

  it('abono parcial: todavía admite plazo', async () => {
    credit = { status: PurchaseCreditStatus.PARTIALLY_PAID };
    await action.execute(100, { payment_due_date: '2099-12-31' }, 42);
    expect(updates).toHaveLength(1);
  });
});

describe('UpdatePurchasePaymentDueDto', () => {
  const pipe = new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
    transformOptions: { enableImplicitConversion: true },
  });
  const meta = { type: 'body' as const, metatype: UpdatePurchasePaymentDueDto };

  it('acepta un día YYYY-MM-DD y null', async () => {
    await expect(pipe.transform({ payment_due_date: '2026-11-06' }, meta)).resolves.toEqual({
      payment_due_date: '2026-11-06',
    });
    await expect(pipe.transform({ payment_due_date: null }, meta)).resolves.toEqual({
      payment_due_date: null,
    });
  });

  it.each([{}, { payment_due_date: '06/11/2026' }, { payment_due_date: 5 }, { foo: 1 }])(
    'rechaza %p',
    async (payload) => {
      await expect(pipe.transform(payload, meta)).rejects.toThrow();
    },
  );
});

describe('UpdatePurchaseDto — payment_due_date', () => {
  const pipe = new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
    transformOptions: { enableImplicitConversion: true },
  });
  const meta = { type: 'body' as const, metatype: UpdatePurchaseDto };

  it('es opcional, admite null y un día', async () => {
    const omitted = (await pipe.transform({}, meta)) as UpdatePurchaseDto;
    expect(omitted.payment_due_date).toBeUndefined();
    const cleared = (await pipe.transform({ payment_due_date: null }, meta)) as UpdatePurchaseDto;
    expect(cleared.payment_due_date).toBeNull();
    const set = (await pipe.transform(
      { payment_due_date: '2026-11-06' },
      meta,
    )) as UpdatePurchaseDto;
    expect(set.payment_due_date).toBe('2026-11-06');
  });

  it('rechaza formatos distintos a YYYY-MM-DD', async () => {
    await expect(
      pipe.transform({ payment_due_date: '2026-11-06T10:00:00Z' }, meta),
    ).rejects.toThrow();
  });
});

describe('UpdatePurchaseAction — plazo de pago (update solo-transporte)', () => {
  let updates: Array<Record<string, unknown>>;
  let action: UpdatePurchaseAction;

  beforeEach(() => {
    updates = [];
    const purchase = { id: '100', company_id: '42', is_deleted: false, purchase_number: 'PUR-1' };
    const getOneQueue: unknown[] = [];
    const manager = {
      createQueryBuilder: jest.fn(() => {
        const qb = {
          setLock: jest.fn().mockReturnThis(),
          where: jest.fn().mockReturnThis(),
          getOne: jest.fn(() => Promise.resolve(getOneQueue.shift() ?? null)),
        };
        return qb;
      }),
      update: jest.fn((_entity: unknown, _where: unknown, values: Record<string, unknown>) => {
        updates.push(values);
        return Promise.resolve({ affected: 1 });
      }),
      findOne: jest.fn((entity: unknown) =>
        Promise.resolve(entityName(entity) === 'Purchase' ? purchase : null),
      ),
      find: jest.fn(() => Promise.resolve([])),
    };
    const dataSource = {
      transaction: jest.fn((_iso: string, cb: (m: typeof manager) => Promise<unknown>) => {
        // purchase, credit, carrierCredit
        getOneQueue.push(purchase, null, null);
        return cb(manager);
      }),
    };
    action = new UpdatePurchaseAction(
      dataSource as unknown as DataSource,
      {} as unknown as FinancialMovementsService,
    );
  });

  const actor = { id: 1, fullName: 'Kike', type: 'owner' };

  it('omitido: conserva el plazo actual (no escribe payment_due_at)', async () => {
    await action.execute(100, { carrier_id: null, transport_cost: 0 }, 42, actor);
    expect(updates).toHaveLength(1);
    expect('payment_due_at' in (updates[0] ?? {})).toBe(false);
  });

  it('con día: lo fija al final del día en Bogotá', async () => {
    await action.execute(100, { payment_due_date: '2099-12-31' }, 42, actor);
    expect((updates[0]?.payment_due_at as Date).toISOString()).toBe('2100-01-01T04:59:59.999Z');
  });

  it('null: quita el plazo', async () => {
    await action.execute(100, { payment_due_date: null }, 42, actor);
    expect(updates[0]?.payment_due_at).toBeNull();
  });

  it('día pasado: 422 y no escribe nada', async () => {
    await expect(
      action.execute(100, { payment_due_date: '2000-01-01' }, 42, actor),
    ).rejects.toThrow('El plazo de pago no puede ser una fecha anterior a hoy');
    expect(updates).toHaveLength(0);
  });
});
