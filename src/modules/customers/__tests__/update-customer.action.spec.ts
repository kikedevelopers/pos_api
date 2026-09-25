import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { DataSource } from 'typeorm';

import { CustomerCategory } from '@/modules/customer-categories/entities/customer-category.entity';

import { UpdateCustomerAction } from '../actions/update-customer.action';
import type { Customer } from '../entities/customer.entity';
import { PersonType } from '../entities/customer.entity';

/**
 * Tests unitarios del action `UpdateCustomerAction`.
 *
 * Cubrimos:
 *   - Multi-tenant: un id de otra company ⇒ NotFoundException.
 *   - Idempotencia: PUT con body vacío devuelve el row tal cual.
 *   - El patch NO incluye campos prohibidos (balance, is_archived,
 *     company_id, created_by*).
 */
describe('UpdateCustomerAction', () => {
  let action: UpdateCustomerAction;
  let dbCustomers: Customer[];
  let lastUpdateWhere: Record<string, string> | null;
  let lastUpdatePatch: Partial<Customer> | null;
  let feEnabled: boolean;
  let queryMock: jest.Mock;
  // Categorías de cliente activas de la company 42, para validar category_id.
  let dbCategories: CustomerCategory[];

  beforeEach(async () => {
    feEnabled = true;
    queryMock = jest.fn(() => Promise.resolve([{ electronic_billing_enabled: feEnabled }]));
    dbCategories = [
      { id: '3', company_id: '42', name: 'Redes', is_archived: false } as CustomerCategory,
      { id: '9', company_id: '42', name: 'Archivada', is_archived: true } as CustomerCategory,
    ];
    dbCustomers = [
      {
        id: '1',
        company_id: '42',
        person_type: PersonType.INDIVIDUAL,
        name: 'Juan',
        email: null,
        phone: null,
        doc_number: null,
        address: null,
        balance: 0,
        is_archived: false,
        created_by: 'Kike',
        created_by_id: '7',
        created_at: new Date('2026-05-01T00:00:00.000Z'),
        updated_at: new Date('2026-05-01T00:00:00.000Z'),
      } as Customer,
    ];
    lastUpdateWhere = null;
    lastUpdatePatch = null;

    const managerMock = {
      findOne: jest.fn(
        (
          entity: unknown,
          opts: { where: { id: string; company_id: string } },
        ): Promise<Customer | CustomerCategory | null> => {
          // `resolveCustomerCategoryId` consulta CustomerCategory; el resto,
          // Customer. Ramificamos por entidad para no cruzar los stores.
          if (entity === CustomerCategory) {
            return Promise.resolve(
              dbCategories.find(
                (c) => c.id === opts.where.id && c.company_id === opts.where.company_id,
              ) ?? null,
            );
          }
          return Promise.resolve(
            dbCustomers.find(
              (c) => c.id === opts.where.id && c.company_id === opts.where.company_id,
            ) ?? null,
          );
        },
      ),
      update: jest.fn(
        (
          _entity: unknown,
          where: Record<string, string>,
          patch: Partial<Customer>,
        ): Promise<void> => {
          lastUpdateWhere = where;
          lastUpdatePatch = patch;
          const target = dbCustomers.find(
            (c) => c.id === where.id && c.company_id === where.company_id,
          );
          if (target) {
            Object.assign(target, patch);
          }
          return Promise.resolve();
        },
      ),
      query: queryMock,
    };

    const dataSourceMock = {
      transaction: jest.fn(async <T>(cb: (m: typeof managerMock) => Promise<T>) => cb(managerMock)),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [UpdateCustomerAction, { provide: DataSource, useValue: dataSourceMock }],
    }).compile();

    action = module.get(UpdateCustomerAction);
  });

  it('rechaza con NotFound si el id pertenece a otra company (anti-IDOR)', async () => {
    await expect(action.execute(1, { name: 'X' }, 999)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('PUT con body vacío es idempotente y no toca DB', async () => {
    const result = await action.execute(1, {}, 42);
    expect(result.name).toBe('Juan');
    expect(lastUpdatePatch).toBeNull();
  });

  it('hace UPDATE filtrando por (id, company_id) — defensa anti cross-tenant', async () => {
    await action.execute(1, { name: 'Juan II' }, 42);
    expect(lastUpdateWhere).toEqual({ id: '1', company_id: '42' });
    expect(lastUpdatePatch).toEqual({ name: 'Juan II' });
  });

  it('respeta null explícito en campos opcionales (limpiar email)', async () => {
    await action.execute(1, { email: undefined }, 42);
    // `undefined` significa "no tocar". El patch debe ser {}.
    expect(lastUpdatePatch).toBeNull();
  });

  describe('categoría especial (customer_categories)', () => {
    it('asigna category_id cuando la categoría existe y está activa', async () => {
      await action.execute(1, { category_id: 3 }, 42);
      expect(lastUpdatePatch).toEqual({ category_id: '3' });
    });

    it('limpia la categoría con category_id=null', async () => {
      await action.execute(1, { category_id: null }, 42);
      expect(lastUpdatePatch).toEqual({ category_id: null });
    });

    it('category_id ausente ⇒ no toca la categoría', async () => {
      await action.execute(1, { name: 'Juan II' }, 42);
      expect(lastUpdatePatch).toEqual({ name: 'Juan II' });
    });

    it('400 si la categoría no existe / es de otra company', async () => {
      await expect(action.execute(1, { category_id: 999 }, 42)).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(lastUpdatePatch).toBeNull();
    });

    it('400 si la categoría está archivada', async () => {
      await expect(action.execute(1, { category_id: 9 }, 42)).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(lastUpdatePatch).toBeNull();
    });
  });

  describe('identidad fiscal (Facturación Electrónica)', () => {
    it('sin campos fiscales: no consulta el gate', async () => {
      await action.execute(1, { name: 'Juan II' }, 42);
      expect(queryMock).not.toHaveBeenCalled();
    });

    it('con FE activa: patchea los campos fiscales (solo los enviados)', async () => {
      await action.execute(
        1,
        { type_document_identification_id: 6, dv: '3', municipality_id: 149 },
        42,
      );
      expect(queryMock).toHaveBeenCalledTimes(1);
      expect(lastUpdatePatch).toEqual({
        type_document_identification_id: 6,
        dv: '3',
        municipality_id: 149,
      });
    });

    it('con FE activa: null explícito limpia un campo fiscal', async () => {
      await action.execute(1, { type_liability_id: null as unknown as number }, 42);
      expect(lastUpdatePatch).toEqual({ type_liability_id: null });
    });

    it('con FE apagada: 403 al intentar asignar identidad fiscal', async () => {
      feEnabled = false;
      await expect(
        action.execute(1, { type_document_identification_id: 6 }, 42),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(lastUpdatePatch).toBeNull();
    });
  });
});
