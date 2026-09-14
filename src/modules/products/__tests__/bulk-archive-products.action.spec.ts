import { Test, type TestingModule } from '@nestjs/testing';
import { DataSource } from 'typeorm';

import { ProductImagesService } from '@/modules/product-images/product-images.service';

import { BulkArchiveProductsAction } from '../actions/bulk-archive-products.action';
import { Product } from '../entities/product.entity';

/**
 * Archivado en lote, con foco en su efecto sobre la imagen: archivar NO borra
 * la foto, le programa una fecha de purga. Se hace en la MISMA transacción que
 * el archivado porque son el mismo hecho — si una se aplicara sin la otra, o la
 * imagen quedaría huérfana para siempre, o se borraría la de un producto activo.
 */

const COMPANY_ID = 42;

async function buildHarness(existing: Array<Partial<Product>>) {
  const archived: Array<{ criteria: unknown; patch: Record<string, unknown> }> = [];
  const managerMock = {
    find: jest.fn(() => Promise.resolve(existing)),
    update: jest.fn((_e: unknown, criteria: unknown, patch: Record<string, unknown>) => {
      archived.push({ criteria, patch });
      return Promise.resolve({ affected: 1, generatedMaps: [], raw: [] });
    }),
    // `assertNotUsedInActiveCombos` consulta combos activos: ninguno.
    query: jest.fn(() => Promise.resolve([])),
    getRepository: jest.fn(() => ({
      createQueryBuilder: jest.fn(() => ({
        select: jest.fn().mockReturnThis(),
        innerJoin: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getRawMany: jest.fn(() => Promise.resolve([])),
        getMany: jest.fn(() => Promise.resolve([])),
      })),
    })),
  };

  const transactionSpy = jest.fn(async <T>(cb: (m: typeof managerMock) => Promise<T>) =>
    cb(managerMock),
  );
  const markArchivedForPurge = jest.fn(() => Promise.resolve());

  const module: TestingModule = await Test.createTestingModule({
    providers: [
      BulkArchiveProductsAction,
      { provide: DataSource, useValue: { transaction: transactionSpy } },
      { provide: ProductImagesService, useValue: { markArchivedForPurge } },
    ],
  }).compile();

  return {
    action: module.get(BulkArchiveProductsAction),
    markArchivedForPurge,
    updates: () => archived,
    manager: managerMock,
  };
}

describe('BulkArchiveProductsAction · archivado', () => {
  it('archiva los productos existentes y reporta los que no encontró', async () => {
    const h = await buildHarness([
      { id: '10', is_archived: false },
      { id: '11', is_archived: false },
    ]);

    const result = await h.action.execute([10, 11, 999], COMPANY_ID);

    expect(result.archived_count).toBe(2);
    expect(result.archived_ids).toEqual([10, 11]);
    expect(result.not_found).toEqual([999]);
  });

  it('es idempotente: un producto ya archivado no se vuelve a contar', async () => {
    const h = await buildHarness([
      { id: '10', is_archived: true },
      { id: '11', is_archived: false },
    ]);

    const result = await h.action.execute([10, 11], COMPANY_ID);

    expect(result.archived_ids).toEqual([11]);
  });

  it('con la lista vacía no toca la base', async () => {
    const h = await buildHarness([]);

    const result = await h.action.execute([], COMPANY_ID);

    expect(result).toEqual({ archived_count: 0, archived_ids: [], not_found: [] });
    expect(h.manager.update).not.toHaveBeenCalled();
  });

  it('descarta ids inválidos del payload', async () => {
    const h = await buildHarness([]);

    const result = await h.action.execute([0, -3, 1.5], COMPANY_ID);

    expect(result.archived_count).toBe(0);
  });
});

describe('BulkArchiveProductsAction · imagen', () => {
  it('programa la purga de la imagen de lo que sí se archivó', async () => {
    const h = await buildHarness([
      { id: '10', is_archived: false },
      { id: '11', is_archived: false },
    ]);

    await h.action.execute([10, 11], COMPANY_ID);

    expect(h.markArchivedForPurge).toHaveBeenCalledWith(
      expect.anything(),
      COMPANY_ID,
      [10, 11],
    );
  });

  it('NO programa purga para los ya archivados (su cuenta regresiva ya corre)', async () => {
    const h = await buildHarness([
      { id: '10', is_archived: true },
      { id: '11', is_archived: false },
    ]);

    await h.action.execute([10, 11], COMPANY_ID);

    expect(h.markArchivedForPurge).toHaveBeenCalledWith(expect.anything(), COMPANY_ID, [11]);
  });

  it('sin nada que archivar no programa ninguna purga', async () => {
    const h = await buildHarness([{ id: '10', is_archived: true }]);

    await h.action.execute([10], COMPANY_ID);

    expect(h.markArchivedForPurge).not.toHaveBeenCalled();
  });

  it('la marca de purga usa el MISMO manager de la transacción del archivado', async () => {
    const h = await buildHarness([{ id: '10', is_archived: false }]);

    await h.action.execute([10], COMPANY_ID);

    expect(h.markArchivedForPurge).toHaveBeenCalledWith(h.manager, COMPANY_ID, [10]);
  });

  it('el archivado sigue filtrando por company (nunca cross-tenant)', async () => {
    const h = await buildHarness([{ id: '10', is_archived: false }]);

    await h.action.execute([10], COMPANY_ID);

    expect(h.updates()[0].criteria).toMatchObject({ company_id: String(COMPANY_ID) });
    expect(h.updates()[0].patch).toEqual({ is_archived: true });
  });
});
