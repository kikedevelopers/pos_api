import { BadRequestException, NotFoundException } from '@nestjs/common';
import type { EntityManager } from 'typeorm';

import { CustomerCategory } from '../../entities/customer-category.entity';
import {
  findCustomerCategoryInCompany,
  resolveCustomerCategoryId,
} from '../customer-category-lookups';

/**
 * Tests de los lookups internos de `customer-categories`.
 *
 * `resolveCustomerCategoryId` es la validación que usan create/update de
 * customers: garantiza que la categoría exista, sea de la company y esté
 * activa antes de asociarla.
 */
describe('customer-category-lookups', () => {
  const makeManager = (found: CustomerCategory | null) =>
    ({ findOne: jest.fn(() => Promise.resolve(found)) }) as unknown as EntityManager & {
      findOne: jest.Mock;
    };

  describe('findCustomerCategoryInCompany', () => {
    it('devuelve la categoría cuando existe', async () => {
      const cat = { id: '3', company_id: '1', is_archived: false } as CustomerCategory;
      const manager = makeManager(cat);
      await expect(findCustomerCategoryInCompany(manager, 3, 1)).resolves.toBe(cat);
      expect(manager.findOne).toHaveBeenCalledWith(CustomerCategory, {
        where: { id: '3', company_id: '1' },
      });
    });

    it('lanza 404 cuando no existe / es de otra company', async () => {
      const manager = makeManager(null);
      await expect(findCustomerCategoryInCompany(manager, 3, 1)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe('resolveCustomerCategoryId', () => {
    it('devuelve null si el id es null (sin consultar la BD)', async () => {
      const manager = makeManager(null);
      await expect(resolveCustomerCategoryId(manager, null, 1)).resolves.toBeNull();
      expect(manager.findOne).not.toHaveBeenCalled();
    });

    it('devuelve null si el id es undefined (sin consultar la BD)', async () => {
      const manager = makeManager(null);
      await expect(resolveCustomerCategoryId(manager, undefined, 1)).resolves.toBeNull();
      expect(manager.findOne).not.toHaveBeenCalled();
    });

    it('devuelve el id (string) si la categoría existe y está activa', async () => {
      const manager = makeManager({ id: '3', is_archived: false } as CustomerCategory);
      await expect(resolveCustomerCategoryId(manager, 3, 1)).resolves.toBe('3');
    });

    it('lanza 400 si la categoría no existe o es de otra company', async () => {
      const manager = makeManager(null);
      await expect(resolveCustomerCategoryId(manager, 999, 1)).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('lanza 400 si la categoría está archivada', async () => {
      const manager = makeManager({ id: '3', is_archived: true } as CustomerCategory);
      await expect(resolveCustomerCategoryId(manager, 3, 1)).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });
  });
});
