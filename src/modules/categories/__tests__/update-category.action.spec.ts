import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { QueryFailedError, type DataSource } from 'typeorm';

import { UpdateCategoryAction } from '../actions/update-category.action';
import { Category } from '../entities/category.entity';

/**
 * `UpdateCategoryAction`: renombra y/o cambia la visibilidad de la categoría
 * completa en el catálogo público. Patch parcial, scoped por company.
 */
describe('UpdateCategoryAction', () => {
  let row: Record<string, unknown> | null;
  let updateSpy: jest.Mock;
  let findOneSpy: jest.Mock;
  let action: UpdateCategoryAction;

  const build = (): void => {
    findOneSpy = jest.fn(() => Promise.resolve(row ? { ...row } : null));
    updateSpy = jest.fn((_entity, _where, patch: Record<string, unknown>) => {
      row = { ...row, ...patch };
      return Promise.resolve({ affected: 1 });
    });
    const manager = { findOne: findOneSpy, update: updateSpy };
    const dataSource = {
      transaction: (cb: (m: unknown) => Promise<unknown>) => cb(manager),
    } as unknown as DataSource;
    action = new UpdateCategoryAction(dataSource);
  };

  beforeEach(() => {
    row = {
      id: '4',
      company_id: '13',
      name: 'Bebidas',
      is_archived: false,
      catalog_visible: true,
    };
    build();
  });

  it('oculta la categoría del catálogo con catalog_visible=false', async () => {
    const result = await action.execute(4, { catalog_visible: false }, 13);

    expect(updateSpy).toHaveBeenCalledWith(
      Category,
      { id: '4', company_id: '13' },
      { catalog_visible: false },
    );
    expect(result.catalog_visible).toBe(false);
  });

  it('vuelve a mostrar la categoría con catalog_visible=true', async () => {
    row = { ...row, catalog_visible: false };
    build();
    const result = await action.execute(4, { catalog_visible: true }, 13);
    expect(updateSpy.mock.calls[0][2]).toEqual({ catalog_visible: true });
    expect(result.catalog_visible).toBe(true);
  });

  it('cambiar la visibilidad NO toca el nombre', async () => {
    await action.execute(4, { catalog_visible: false }, 13);
    expect(updateSpy.mock.calls[0][2]).not.toHaveProperty('name');
  });

  it('renombrar NO toca la visibilidad en catálogo', async () => {
    await action.execute(4, { name: '  Licores ' }, 13);
    expect(updateSpy.mock.calls[0][2]).toEqual({ name: 'Licores' });
  });

  it('acepta nombre y visibilidad en el mismo PUT', async () => {
    await action.execute(4, { name: 'Licores', catalog_visible: false }, 13);
    expect(updateSpy.mock.calls[0][2]).toEqual({ name: 'Licores', catalog_visible: false });
  });

  it('PUT vacío es no-op (sin UPDATE)', async () => {
    const result = await action.execute(4, {}, 13);
    expect(updateSpy).not.toHaveBeenCalled();
    expect(result.name).toBe('Bebidas');
  });

  it('busca la categoría SOLO dentro de la company del token', async () => {
    await action.execute(4, { catalog_visible: false }, 13);
    expect(findOneSpy.mock.calls[0][1]).toEqual({ where: { id: '4', company_id: '13' } });
  });

  it('404 si la categoría no existe o es de otra company', async () => {
    row = null;
    build();
    await expect(action.execute(4, { catalog_visible: false }, 13)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(updateSpy).not.toHaveBeenCalled();
  });

  it('404 si la categoría está archivada', async () => {
    row = { ...row, is_archived: true };
    build();
    await expect(action.execute(4, { catalog_visible: false }, 13)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(updateSpy).not.toHaveBeenCalled();
  });

  it('400 si el nombre llega en blanco', async () => {
    await expect(action.execute(4, { name: '   ' }, 13)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('409 si el nombre colisiona con otra categoría activa', async () => {
    updateSpy.mockImplementationOnce(() => {
      const err = new QueryFailedError('UPDATE', [], new Error('dup')) as QueryFailedError & {
        code: string;
        constraint: string;
      };
      err.code = '23505';
      err.constraint = 'idx_categories_company_name_unique';
      return Promise.reject(err);
    });
    await expect(action.execute(4, { name: 'Snacks' }, 13)).rejects.toBeInstanceOf(
      ConflictException,
    );
  });
});
