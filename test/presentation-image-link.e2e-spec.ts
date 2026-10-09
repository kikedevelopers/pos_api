import type { DataSource } from 'typeorm';

import { GetItemsAction } from '@/modules/pos-data/actions/get-items.action';
import { UpdateProductAction } from '@/modules/products/actions/update-product.action';

import {
  cleanupCompany,
  createDisposableCompany,
  insertOwnerUser,
  insertPrice,
  insertProduct,
  tryInitDataSource,
} from './helpers/e2e-db';

/**
 * e2e (BD REAL) del VÍNCULO de imagen presentación→base en el POS.
 *
 * Una presentación con `use_parent_image = true` no guarda imagen propia: al
 * listar los items del POS debe devolver la RUTA de la imagen del PADRE (que
 * luego se firma en lote). Una presentación con imagen propia devuelve la suya,
 * y el base la suya. Así se evita duplicar el archivo en el almacenamiento sin
 * compartir la ruta del objeto en el bucket.
 *
 * Skip limpio si no hay BD. Company desechable, cleanup total en afterAll.
 */

const COMPANY = '__E2E_IMG_LINK__';

describe('Vínculo de imagen presentación→base (e2e, pos_db) — POS', () => {
  let ds: DataSource | null = null;
  let companyId = 0;

  beforeAll(async () => {
    ds = await tryInitDataSource();
    if (!ds) {
      // eslint-disable-next-line no-console
      console.warn('[e2e] pos_db no disponible — presentation-image-link e2e SKIPPED.');
      return;
    }
    companyId = await createDisposableCompany(ds, COMPANY);
  });

  afterAll(async () => {
    if (!ds) return;
    await cleanupCompany(ds, companyId);
    await ds.destroy();
  });

  it('la presentación VINCULADA devuelve la imagen del base; las no vinculadas, la suya', async () => {
    if (!ds) return;

    // Base CON imagen propia.
    const baseId = await insertProduct(ds, companyId, { name: 'CAFE MOLIDO', cost: 10000 });
    const baseImage = `inventory_items/${companyId}/${baseId}-base.jpg`;
    await ds.query(`UPDATE products SET image = $1 WHERE id = $2`, [baseImage, baseId]);
    await insertPrice(ds, companyId, baseId, 12000, 2000, 16.66);

    // Presentación VINCULADA (sin imagen propia, use_parent_image = true).
    const linkedId = await insertProduct(ds, companyId, {
      name: 'CAFE MOLIDO *250G',
      cost: 2500,
      parentId: baseId,
    });
    await ds.query(`UPDATE products SET use_parent_image = true WHERE id = $1`, [linkedId]);
    await insertPrice(ds, companyId, linkedId, 3000, 500, 16.66);

    // Presentación CON imagen propia (no vinculada).
    const ownId = await insertProduct(ds, companyId, {
      name: 'CAFE MOLIDO *500G',
      cost: 5000,
      parentId: baseId,
    });
    const ownImage = `inventory_items/${companyId}/${ownId}-own.jpg`;
    await ds.query(`UPDATE products SET image = $1 WHERE id = $2`, [ownImage, ownId]);
    await insertPrice(ds, companyId, ownId, 6000, 1000, 16.66);

    const items = await new GetItemsAction(ds).execute(companyId);
    const byId = new Map(items.map((i) => [i.id, i]));

    const base = byId.get(Number(baseId));
    const linked = byId.get(Number(linkedId));
    const own = byId.get(Number(ownId));

    expect(base?.image).toBe(baseImage);
    // La vinculada pinta la imagen del BASE, no una propia.
    expect(linked?.image).toBe(baseImage);
    // La de imagen propia conserva la suya.
    expect(own?.image).toBe(ownImage);
  });

  it('presentación vinculada a un base SIN imagen → image null (placeholder)', async () => {
    if (!ds) return;

    const baseId = await insertProduct(ds, companyId, { name: 'TE VERDE', cost: 8000 });
    const linkedId = await insertProduct(ds, companyId, {
      name: 'TE VERDE *100G',
      cost: 2000,
      parentId: baseId,
    });
    await ds.query(`UPDATE products SET use_parent_image = true WHERE id = $1`, [linkedId]);

    const items = await new GetItemsAction(ds).execute(companyId);
    const linked = items.find((i) => i.id === Number(linkedId));

    expect(linked).toBeDefined();
    expect(linked?.image).toBeNull();
  });

  it('UPDATE: una presentación persiste y revierte use_parent_image', async () => {
    if (!ds) return;
    const actorId = await insertOwnerUser(ds, companyId, 'imglink_upd');
    const actor = { id: actorId, fullName: 'E2E Owner' };
    const action = new UpdateProductAction(ds);

    const baseId = await insertProduct(ds, companyId, { name: 'AVENA', cost: 4000 });
    const presId = await insertProduct(ds, companyId, {
      name: 'AVENA *250G',
      cost: 1000,
      parentId: baseId,
    });

    // Activar el vínculo.
    await action.execute(Number(presId), { use_parent_image: true }, companyId, actor);
    let [row] = await ds.query<Array<{ use_parent_image: boolean }>>(
      `SELECT use_parent_image FROM products WHERE id = $1`,
      [presId],
    );
    expect(row.use_parent_image).toBe(true);

    // Desactivarlo (quiere imagen propia).
    await action.execute(Number(presId), { use_parent_image: false }, companyId, actor);
    [row] = await ds.query<Array<{ use_parent_image: boolean }>>(
      `SELECT use_parent_image FROM products WHERE id = $1`,
      [presId],
    );
    expect(row.use_parent_image).toBe(false);
  });

  it('UPDATE: convertir una presentación en base apaga use_parent_image', async () => {
    if (!ds) return;
    const actorId = await insertOwnerUser(ds, companyId, 'imglink_conv');
    const actor = { id: actorId, fullName: 'E2E Owner' };
    const action = new UpdateProductAction(ds);

    const baseId = await insertProduct(ds, companyId, { name: 'GRANOLA', cost: 6000 });
    const presId = await insertProduct(ds, companyId, {
      name: 'GRANOLA *500G',
      cost: 3000,
      parentId: baseId,
    });
    await ds.query(`UPDATE products SET use_parent_image = true WHERE id = $1`, [presId]);

    // Pasa a ser producto base (parent_id = null): el vínculo deja de aplicar.
    await action.execute(Number(presId), { parent_id: null }, companyId, actor);

    const [row] = await ds.query<Array<{ parent_id: string | null; use_parent_image: boolean }>>(
      `SELECT parent_id, use_parent_image FROM products WHERE id = $1`,
      [presId],
    );
    expect(row.parent_id).toBeNull();
    expect(row.use_parent_image).toBe(false);
  });
});
