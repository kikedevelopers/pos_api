import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import type { DataSource } from 'typeorm';

import { UpdateCatalogSettingsAction } from '../actions/update-catalog-settings.action';
import type { UpdateCatalogSettingsDto } from '../dto/update-catalog-settings.dto';
import type { Company } from '../entities/company.entity';

/**
 * `UpdateCatalogSettingsAction`: normaliza el slug, respeta la unicidad global,
 * exige slug para habilitar y permite borrarlo solo con el catálogo apagado.
 */
describe('UpdateCatalogSettingsAction', () => {
  let action: UpdateCatalogSettingsAction;
  let company: Company;
  /** Slug ya tomado por OTRA company, para la prueba de unicidad. */
  let takenSlug: string | null;
  let lastPatch: Partial<Company> | null;
  let updateThrows: unknown;

  const build = (): void => {
    lastPatch = null;
    const manager = {
      findOne: jest.fn((_entity: unknown, opts: { where: Record<string, unknown> }) => {
        // Chequeo de unicidad: where incluye catalog_slug + id (Not).
        if ('catalog_slug' in opts.where) {
          const wanted = opts.where.catalog_slug as string;
          return Promise.resolve(takenSlug === wanted ? ({ id: '999' } as Company) : null);
        }
        // Carga por id.
        return Promise.resolve(company);
      }),
      update: jest.fn((_entity: unknown, _where: unknown, patch: Partial<Company>) => {
        if (updateThrows) {
          return Promise.reject(updateThrows);
        }
        lastPatch = patch;
        Object.assign(company, patch);
        return Promise.resolve({ affected: 1 });
      }),
    };
    const dataSource = {
      transaction: <T>(cb: (m: typeof manager) => Promise<T>): Promise<T> => cb(manager),
    } as unknown as DataSource;
    action = new UpdateCatalogSettingsAction(dataSource);
  };

  beforeEach(() => {
    company = {
      id: '42',
      name: 'Esencia & Grano',
      catalog_slug: null,
      catalog_enabled: false,
      catalog_group_by_category: false,
    } as Company;
    takenSlug = null;
    updateThrows = null;
    build();
  });

  const run = (dto: UpdateCatalogSettingsDto): Promise<Company> => action.execute(42, dto);

  it('normaliza el slug antes de guardar', async () => {
    await run({ slug: 'Esencia y Grano' });
    expect(lastPatch).toEqual({ catalog_slug: 'esenciaygrano' });
  });

  it('habilita con slug nuevo en una sola llamada', async () => {
    const result = await run({ slug: 'esenciaygrano', catalog_enabled: true });
    expect(result.catalog_slug).toBe('esenciaygrano');
    expect(result.catalog_enabled).toBe(true);
  });

  it('rechaza habilitar sin slug (ni nuevo ni guardado)', async () => {
    await expect(run({ catalog_enabled: true })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('permite habilitar usando el slug ya guardado', async () => {
    company.catalog_slug = 'laveintiuna';
    await expect(run({ catalog_enabled: true })).resolves.toMatchObject({
      catalog_enabled: true,
    });
  });

  it('rechaza un slug inválido (vacío tras normalizar)', async () => {
    await expect(run({ slug: '---' })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rechaza un slug ya usado por otra company (409)', async () => {
    takenSlug = 'esenciaygrano';
    await expect(run({ slug: 'esenciaygrano' })).rejects.toBeInstanceOf(ConflictException);
  });

  it('traduce la violación de unicidad de la BD (23505) a 409', async () => {
    updateThrows = { code: '23505' };
    await expect(run({ slug: 'otroslug' })).rejects.toBeInstanceOf(ConflictException);
  });

  it('borra el slug cuando llega vacío y el catálogo queda apagado', async () => {
    company.catalog_slug = 'viejo';
    const result = await run({ slug: '', catalog_enabled: false });
    expect(result.catalog_slug).toBeNull();
  });

  it('NO deja borrar el slug si el catálogo sigue habilitado', async () => {
    company.catalog_slug = 'viejo';
    company.catalog_enabled = true;
    await expect(run({ slug: '' })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('activa la agrupación por categoría sin tocar el slug', async () => {
    company.catalog_slug = 'esenciaygrano';
    const result = await run({ catalog_group_by_category: true });
    expect(lastPatch).toEqual({ catalog_group_by_category: true });
    expect(result.catalog_group_by_category).toBe(true);
  });

  it('no incluye la preferencia de agrupación cuando el DTO no la trae', async () => {
    await run({ slug: 'esenciaygrano' });
    expect(lastPatch).toEqual({ catalog_slug: 'esenciaygrano' });
    expect(lastPatch).not.toHaveProperty('catalog_group_by_category');
  });

  it('desactivar la agrupación por categoría no exige slug', async () => {
    company.catalog_group_by_category = true;
    const result = await run({ catalog_group_by_category: false });
    expect(result.catalog_group_by_category).toBe(false);
  });

  it('una company inexistente ⇒ NotFound', async () => {
    company = null as unknown as Company;
    build();
    await expect(run({ slug: 'algo' })).rejects.toBeInstanceOf(NotFoundException);
  });
});
