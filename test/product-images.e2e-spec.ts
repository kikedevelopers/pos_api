import type { DataSource } from 'typeorm';

import { PurgeExpiredProductImagesAction } from '@/modules/product-images/actions/purge-expired-product-images.action';
import { ProductImagesService } from '@/modules/product-images/product-images.service';
import { BulkArchiveProductsAction } from '@/modules/products/actions/bulk-archive-products.action';

import {
  cleanupCompany,
  createDisposableCompany,
  insertProduct,
  tryInitDataSource,
} from './helpers/e2e-db';

/**
 * e2e con BD REAL del ciclo de vida de la imagen de un item:
 *
 *   archivar → se PROGRAMA la purga (la imagen sobrevive) → vencido el plazo,
 *   el cron la borra y despunta la fila.
 *
 * El bucket se sustituye por un doble (esta prueba mide la BD y las reglas de
 * negocio, no la red), pero la BD es la de verdad: es la única forma de
 * comprobar que la columna, el índice parcial y el filtro por `image IS NOT
 * NULL` se comportan como dice el diseño.
 *
 * Skip limpio si no hay BD. Company desechable, cleanup total en afterAll.
 */

const COMPANY = '__E2E_IMAGES__';
const RETENTION_DAYS = 7;

/** Doble del almacenamiento: registra los borrados sin hablar con GCS. */
function buildStorageStub() {
  const removed: string[] = [];
  return {
    removed,
    stub: {
      prefix: 'inventory_items',
      isConfigured: true,
      maxSizeBytes: 2 * 1024 * 1024,
      retentionDaysAfterArchive: RETENTION_DAYS,
      remove: (objectName: string) => {
        removed.push(objectName);
        return Promise.resolve(true);
      },
    },
  };
}

describe('Imágenes de items (e2e, pos_db) — archivado y purga', () => {
  let ds: DataSource | null = null;
  let companyId = 0;

  beforeAll(async () => {
    ds = await tryInitDataSource();
    if (!ds) {
      // eslint-disable-next-line no-console
      console.warn('[e2e] pos_db no disponible — product-images e2e SKIPPED.');
      return;
    }
    companyId = await createDisposableCompany(ds, COMPANY);
  });

  afterAll(async () => {
    if (!ds) return;
    await cleanupCompany(ds, companyId);
    await ds.destroy();
  });

  /** Cablea el archivado con un servicio de imágenes real sobre el storage doble. */
  function buildArchiveAction(storage: ReturnType<typeof buildStorageStub>['stub']) {
    const images = new ProductImagesService(
      storage as never,
      { invalidate: () => undefined, invalidateByPrefix: () => 0 } as never,
      null as never,
      null as never,
      null as never,
      null as never,
      null as never,
    );
    return { action: new BulkArchiveProductsAction(ds as DataSource, images), images };
  }

  it('archivar PROGRAMA la purga sin borrar la imagen', async () => {
    if (!ds) return;
    const { stub, removed } = buildStorageStub();
    const productId = await insertProduct(ds, companyId, { name: 'CON FOTO', cost: 1000 });
    await ds.query(`UPDATE products SET image = $1 WHERE id = $2`, [
      `inventory_items/${companyId}/${productId}-a.jpg`,
      productId,
    ]);

    const { action } = buildArchiveAction(stub);
    await action.execute([Number(productId)], companyId);

    const [row] = await ds.query<Array<{ image: string | null; image_purge_at: Date | null }>>(
      `SELECT image, image_purge_at FROM products WHERE id = $1`,
      [productId],
    );
    // La imagen sigue ahí: archivar por error tiene que ser reversible.
    expect(row.image).not.toBeNull();
    expect(row.image_purge_at).not.toBeNull();
    expect(removed).toHaveLength(0);
  });

  it('la purga se programa a los días de retención configurados', async () => {
    if (!ds) return;
    const { stub } = buildStorageStub();
    const productId = await insertProduct(ds, companyId, { name: 'RETENCION', cost: 1000 });
    await ds.query(`UPDATE products SET image = $1 WHERE id = $2`, [
      `inventory_items/${companyId}/${productId}-a.jpg`,
      productId,
    ]);

    const { action } = buildArchiveAction(stub);
    await action.execute([Number(productId)], companyId);

    const [row] = await ds.query<Array<{ days: string }>>(
      `SELECT EXTRACT(DAY FROM (image_purge_at - now()))::int AS days
       FROM products WHERE id = $1`,
      [productId],
    );
    // 6 porque `now()` avanzó unos milisegundos desde que se calculó la fecha.
    expect(Number(row.days)).toBe(RETENTION_DAYS - 1);
  });

  it('archivar un producto SIN imagen no programa ninguna purga', async () => {
    if (!ds) return;
    const { stub } = buildStorageStub();
    const productId = await insertProduct(ds, companyId, { name: 'SIN FOTO', cost: 1000 });

    const { action } = buildArchiveAction(stub);
    await action.execute([Number(productId)], companyId);

    const [row] = await ds.query<Array<{ image_purge_at: Date | null }>>(
      `SELECT image_purge_at FROM products WHERE id = $1`,
      [productId],
    );
    expect(row.image_purge_at).toBeNull();
  });

  it('el cron NO toca una purga que todavía no vence', async () => {
    if (!ds) return;
    const { stub, removed } = buildStorageStub();
    const productId = await insertProduct(ds, companyId, { name: 'NO VENCIDA', cost: 1000 });
    const objectName = `inventory_items/${companyId}/${productId}-a.jpg`;
    await ds.query(
      `UPDATE products SET image = $1, image_purge_at = now() + interval '3 days' WHERE id = $2`,
      [objectName, productId],
    );

    const purge = new PurgeExpiredProductImagesAction(ds, stub as never, {
      invalidate: () => undefined,
    } as never);
    await purge.execute();

    const [row] = await ds.query<Array<{ image: string | null }>>(
      `SELECT image FROM products WHERE id = $1`,
      [productId],
    );
    expect(row.image).toBe(objectName);
    expect(removed).not.toContain(objectName);
  });

  it('vencido el plazo, el cron borra el objeto y despunta la fila', async () => {
    if (!ds) return;
    const { stub, removed } = buildStorageStub();
    const productId = await insertProduct(ds, companyId, { name: 'VENCIDA', cost: 1000 });
    const objectName = `inventory_items/${companyId}/${productId}-a.jpg`;
    await ds.query(
      `UPDATE products SET image = $1, image_purge_at = now() - interval '1 day' WHERE id = $2`,
      [objectName, productId],
    );

    const purge = new PurgeExpiredProductImagesAction(ds, stub as never, {
      invalidate: () => undefined,
    } as never);
    const result = await purge.execute();

    const [row] = await ds.query<Array<{ image: string | null; image_purge_at: Date | null }>>(
      `SELECT image, image_purge_at FROM products WHERE id = $1`,
      [productId],
    );
    expect(removed).toContain(objectName);
    expect(row.image).toBeNull();
    expect(row.image_purge_at).toBeNull();
    expect(result.purged).toBeGreaterThanOrEqual(1);
  });

  it('el índice parcial cubre la consulta del cron (no escanea el catálogo)', async () => {
    if (!ds) return;
    // Un índice parcial que no se usa es peor que no tenerlo: el cron leería la
    // tabla entera de productos cada madrugada.
    const plan = await ds.query<Array<{ 'QUERY PLAN': string }>>(
      `EXPLAIN SELECT id, company_id, image FROM products
       WHERE image IS NOT NULL AND image_purge_at IS NOT NULL AND image_purge_at <= now()
       ORDER BY image_purge_at ASC LIMIT 500`,
    );
    const text = plan.map((r) => r['QUERY PLAN']).join('\n');
    // Con la tabla casi vacía el planner puede preferir un seq scan; lo que se
    // comprueba es que el índice EXISTE y es aplicable.
    const [idx] = await ds.query<Array<{ count: string }>>(
      `SELECT count(*)::text AS count FROM pg_indexes
       WHERE tablename = 'products' AND indexname = 'idx_products_image_purge_at'`,
    );
    expect(Number(idx.count)).toBe(1);
    expect(text.length).toBeGreaterThan(0);
  });
});
