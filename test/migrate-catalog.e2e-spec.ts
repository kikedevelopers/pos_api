import {
  createHash,
  generateKeyPairSync,
  sign as edSign,
  type KeyPairKeyObjectResult,
} from 'node:crypto';
import type { Server } from 'node:http';

import { HttpStatus, type INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import request from 'supertest';
import type { DataSource } from 'typeorm';

import { AdminSignatureGuard } from '@/common/guards/admin-signature.guard';
import { MigrateCatalogAction } from '@/modules/superadmin/actions/migrate-catalog.action';
import type {
  MigrateCatalogBody,
  MigrateCatalogResult,
} from '@/modules/superadmin/internal/migrate-catalog.helpers';
import { MigrateCatalogController } from '@/modules/superadmin/migrate-catalog.controller';

import {
  cleanupCompany,
  createDisposableCompany,
  insertOwnerUser,
  tryInitDataSource,
} from './helpers/e2e-db';

/**
 * Tests de la migración de catálogo Mongo → pos_api.
 *
 *   - Suite A (integración con pos_db REAL): ejercita `MigrateCatalogAction`
 *     directamente contra una company desechable. Verifica jerarquía
 *     base↔presentación, idempotencia, huérfanos, find-or-create de
 *     categorías/empaques, dedupe de nombres en el batch, costo/precio de
 *     presentación y dedupe de clientes. Skip limpio si no hay BD.
 *   - Suite B (HTTP con firma): valida el guard `AdminSignatureGuard` y el
 *     ruteo del controller dedicado, con el action MOCKEADO (sin BD): firma
 *     válida → 201; firma inválida / ausente → 401.
 */

// ─── Helpers de payload ──────────────────────────────────────────────────────

interface PriceIn {
  name?: string;
  sale_price: number;
  iva_percentage?: number;
}

function baseProduct(
  srcId: string,
  name: string,
  cost: number,
  stock: number,
  prices: PriceIn[],
  category?: string | null,
): MigrateCatalogBody['products'][number] {
  return { srcId, name, cost, stock, parentSrcId: null, category: category ?? null, prices };
}

function presentation(
  srcId: string,
  name: string,
  parentSrcId: string,
  cost: number,
  packaging: { name: string; value: number },
  prices: PriceIn[],
  category?: string | null,
): MigrateCatalogBody['products'][number] {
  return {
    srcId,
    name,
    cost,
    stock: 0,
    parentSrcId,
    category: category ?? null,
    packaging,
    prices,
  };
}

// ─── Cleanup local (cleanupCompany NO borra customers) ───────────────────────

async function cleanupCatalogCompany(ds: DataSource, companyId: number): Promise<void> {
  await ds.query(`DELETE FROM customers WHERE company_id = $1`, [String(companyId)]);
  await cleanupCompany(ds, companyId);
}

// ═══════════════════════════════════════════════════════════════════════════
// Suite A — Integración con BD real
// ═══════════════════════════════════════════════════════════════════════════

describe('MigrateCatalogAction (integración, pos_db)', () => {
  let ds: DataSource | null = null;
  let action: MigrateCatalogAction;
  const createdCompanies: number[] = [];

  beforeAll(async () => {
    ds = await tryInitDataSource();
    if (!ds) {
      // eslint-disable-next-line no-console
      console.warn('[e2e] pos_db no disponible — migrate-catalog integración SKIPPED.');
      return;
    }
    action = new MigrateCatalogAction(ds);
  });

  afterAll(async () => {
    if (!ds) {
      return;
    }
    for (const id of createdCompanies) {
      await cleanupCatalogCompany(ds, id);
    }
    await ds.destroy();
  });

  async function freshCompany(name: string): Promise<number> {
    const id = await createDisposableCompany(ds!, name);
    createdCompanies.push(id);
    await insertOwnerUser(ds!, id, `mc_${Date.now()}`);
    return id;
  }

  async function productByName(companyId: number, name: string) {
    const rows = await ds!.query(
      `SELECT * FROM products WHERE company_id = $1 AND lower(btrim(name)) = lower(btrim($2)) AND is_archived = false`,
      [String(companyId), name],
    );
    return rows;
  }

  async function pricesOf(productId: string) {
    return ds!.query(
      `SELECT sale_price::float AS sale, profit::float AS profit, margin::float AS margin, iva_percentage::float AS iva
         FROM product_prices WHERE product_id = $1 ORDER BY sale_price DESC`,
      [productId],
    );
  }

  it('(a) happy path: inserta bases + presentaciones con parent_id correcto y N precios', async () => {
    if (!ds) {
      return;
    }
    const companyId = await freshCompany('__E2E_MC_HAPPY__');

    const body: MigrateCatalogBody = {
      meta: { businessName: 'Surtidor Test', mongoBusinessId: 'abc123' },
      products: [
        baseProduct('b1', 'Arroz', 100, 50, [{ sale_price: 150, iva_percentage: 0 }], 'Granos'),
        presentation(
          'p1',
          'Arroz Bulto',
          'b1',
          500,
          { name: 'Bulto', value: 5 },
          [{ sale_price: 700, iva_percentage: 0 }],
          'Granos',
        ),
        baseProduct(
          'b2',
          'Aceite',
          80,
          20,
          [{ sale_price: 120 }, { name: 'Mayor', sale_price: 110 }],
          'Aceites',
        ),
      ],
      customers: [],
    };

    const res = await action.execute(companyId, body);

    expect(res.products.inserted).toBe(3);
    expect(res.presentations.inserted).toBe(1);
    expect(res.categories.created).toBe(2);
    expect(res.packagings.created).toBe(1);
    expect(res.prices.inserted).toBe(4); // 1 + 1 + 2
    expect(res.business).toEqual({ name: 'Surtidor Test', mongoId: 'abc123' });

    const arroz = (await productByName(companyId, 'Arroz'))[0];
    const bulto = (await productByName(companyId, 'Arroz Bulto'))[0];
    expect(arroz.parent_id).toBeNull();
    expect(bulto.parent_id).toBe(arroz.id); // (a) jerarquía correcta
    expect(bulto.packaging_id).not.toBeNull();
    expect(parseFloat(bulto.stock)).toBe(0); // presentación stock 0
    expect(parseFloat(bulto.cost)).toBe(500);

    // Categoría heredada por la presentación.
    expect(bulto.category_id).toBe(arroz.category_id);
    expect(bulto.category_id).not.toBeNull();

    // (f) costo/precio de la presentación correctos (profit/margin Big.js).
    const bultoPrices = await pricesOf(bulto.id);
    expect(bultoPrices).toHaveLength(1);
    expect(bultoPrices[0].profit).toBe(200); // 700 - 500
    expect(bultoPrices[0].margin).toBeCloseTo((200 / 700) * 100, 4);

    const aceitePrices = await pricesOf((await productByName(companyId, 'Aceite'))[0].id);
    expect(aceitePrices).toHaveLength(2);
  });

  it('(b) idempotencia: 2ª corrida NO duplica (skippedExisting) y cuelga presentaciones nuevas del base existente', async () => {
    if (!ds) {
      return;
    }
    const companyId = await freshCompany('__E2E_MC_IDEM__');

    const first: MigrateCatalogBody = {
      products: [
        baseProduct('b1', 'Arroz', 100, 50, [{ sale_price: 150 }], 'Granos'),
        presentation(
          'p1',
          'Arroz Bulto',
          'b1',
          500,
          { name: 'Bulto', value: 5 },
          [{ sale_price: 700 }],
          'Granos',
        ),
      ],
      customers: [],
    };
    await action.execute(companyId, first);

    // 2ª corrida: mismos 2 + una presentación NUEVA colgada del MISMO base (b1).
    const second: MigrateCatalogBody = {
      products: [
        baseProduct('b1', 'Arroz', 100, 50, [{ sale_price: 150 }], 'Granos'),
        presentation(
          'p1',
          'Arroz Bulto',
          'b1',
          500,
          { name: 'Bulto', value: 5 },
          [{ sale_price: 700 }],
          'Granos',
        ),
        presentation(
          'p2',
          'Arroz Media',
          'b1',
          250,
          { name: 'Media', value: 2 },
          [{ sale_price: 380 }],
          'Granos',
        ),
      ],
      customers: [],
    };
    const res = await action.execute(companyId, second);

    // Arroz (base) y Arroz Bulto (presentación) ya existen → skippedExisting.
    expect(res.products.skippedExisting).toBe(2);
    expect(res.products.inserted).toBe(1); // solo Arroz Media
    expect(res.presentations.inserted).toBe(1);
    expect(res.presentations.skipped).toBe(1); // Arroz Bulto ya existía

    // No se duplicó nada en la BD.
    expect(await productByName(companyId, 'Arroz')).toHaveLength(1);
    expect(await productByName(companyId, 'Arroz Bulto')).toHaveLength(1);
    const media = (await productByName(companyId, 'Arroz Media'))[0];
    const arroz = (await productByName(companyId, 'Arroz'))[0];
    // La presentación NUEVA cuelga del base EXISTENTE (reutilizado como parent).
    expect(media.parent_id).toBe(arroz.id);

    const total = await ds.query(
      `SELECT COUNT(*)::int AS n FROM products WHERE company_id = $1 AND is_archived = false`,
      [String(companyId)],
    );
    expect(total[0].n).toBe(3);
  });

  it('(c) presentación huérfana (parent excluido / inexistente) → skippedOrphan', async () => {
    if (!ds) {
      return;
    }
    const companyId = await freshCompany('__E2E_MC_ORPHAN__');

    const body: MigrateCatalogBody = {
      products: [
        presentation('p1', 'Huerfana', 'ghost-base', 300, { name: 'Caja', value: 3 }, [
          { sale_price: 400 },
        ]),
      ],
      customers: [],
    };
    const res = await action.execute(companyId, body);

    expect(res.products.skippedOrphan).toBe(1);
    expect(res.products.inserted).toBe(0);
    expect(res.presentations.skipped).toBe(1);
    expect(await productByName(companyId, 'Huerfana')).toHaveLength(0);
  });

  it('(d) categorías y empaques find-or-create (created/reused correctos)', async () => {
    if (!ds) {
      return;
    }
    const companyId = await freshCompany('__E2E_MC_FOC__');

    // 1ª corrida: crea categoría "Bebidas" y empaque "Sixpack".
    await action.execute(companyId, {
      products: [
        baseProduct('b1', 'Gaseosa', 50, 10, [{ sale_price: 80 }], 'Bebidas'),
        presentation(
          'p1',
          'Gaseosa Six',
          'b1',
          300,
          { name: 'Sixpack', value: 6 },
          [{ sale_price: 450 }],
          'Bebidas',
        ),
      ],
      customers: [],
    });

    // 2ª corrida en la MISMA company: nuevos productos que reusan categoría y
    // empaque existentes.
    const res = await action.execute(companyId, {
      products: [
        baseProduct('b2', 'Agua', 40, 10, [{ sale_price: 70 }], 'Bebidas'),
        presentation(
          'p2',
          'Agua Six',
          'b2',
          240,
          { name: 'Sixpack', value: 6 },
          [{ sale_price: 400 }],
          'Bebidas',
        ),
      ],
      customers: [],
    });

    expect(res.categories.created).toBe(0);
    expect(res.categories.reused).toBe(1); // Bebidas reusada
    expect(res.packagings.created).toBe(0);
    expect(res.packagings.reused).toBe(1); // Sixpack reusado

    // Solo hay UNA categoría "Bebidas" y UN empaque "Sixpack".
    const cats = await ds.query(
      `SELECT COUNT(*)::int AS n FROM categories WHERE company_id = $1 AND lower(btrim(name)) = 'bebidas'`,
      [String(companyId)],
    );
    expect(cats[0].n).toBe(1);
    const pkgs = await ds.query(
      `SELECT COUNT(*)::int AS n FROM packagings WHERE company_id = $1 AND lower(btrim(name)) = 'sixpack'`,
      [String(companyId)],
    );
    expect(pkgs[0].n).toBe(1);
  });

  it('(d.2) empaque mismo nombre pero OTRO value → nombre canónico "nombre × value"', async () => {
    if (!ds) {
      return;
    }
    const companyId = await freshCompany('__E2E_MC_PKGCANON__');

    const res = await action.execute(companyId, {
      products: [
        baseProduct('b1', 'Leche', 30, 10, [{ sale_price: 50 }]),
        presentation('p1', 'Leche Caja 6', 'b1', 180, { name: 'Caja', value: 6 }, [
          { sale_price: 300 },
        ]),
        presentation('p2', 'Leche Caja 12', 'b1', 360, { name: 'Caja', value: 12 }, [
          { sale_price: 580 },
        ]),
      ],
      customers: [],
    });

    expect(res.packagings.created).toBe(2); // "Caja" y "Caja × 12"

    const names = (
      await ds.query(`SELECT name FROM packagings WHERE company_id = $1 ORDER BY name`, [
        String(companyId),
      ])
    ).map((r: { name: string }) => r.name);
    expect(names).toContain('Caja');
    expect(names).toContain('Caja × 12');

    const caja6 = (await productByName(companyId, 'Leche Caja 6'))[0];
    const caja12 = (await productByName(companyId, 'Leche Caja 12'))[0];
    expect(caja6.packaging_id).not.toBe(caja12.packaging_id); // empaques distintos
  });

  it('(e) dedupe de nombres duplicados en el batch → skippedDuplicate', async () => {
    if (!ds) {
      return;
    }
    const companyId = await freshCompany('__E2E_MC_DEDUPE__');

    const res = await action.execute(companyId, {
      products: [
        baseProduct('b1', 'Repetido', 10, 5, [{ sale_price: 20 }]),
        baseProduct('b2', ' repetido ', 99, 99, [{ sale_price: 30 }]), // mismo nameKey
        baseProduct('b3', 'Unico', 15, 5, [{ sale_price: 25 }]),
      ],
      customers: [],
    });

    expect(res.products.inserted).toBe(2); // Repetido (1º) + Unico
    expect(res.products.skippedDuplicate).toBe(1); // el 2º "repetido"

    // Solo hay UNA fila "repetido", y conserva el COSTO del PRIMERO (10, no 99).
    const rep = await productByName(companyId, 'Repetido');
    expect(rep).toHaveLength(1);
    expect(parseFloat(rep[0].cost)).toBe(10);
  });

  it('(g.clientes) clientes: inserta + dedupe existentes/batch', async () => {
    if (!ds) {
      return;
    }
    const companyId = await freshCompany('__E2E_MC_CUST__');

    // Cliente "Ana" ya existe en el destino.
    await ds.query(
      `INSERT INTO customers (company_id, person_type, name, balance, advance_balance, points, is_archived)
       VALUES ($1, 'INDIVIDUAL', 'Ana', 0, 0, 0, false)`,
      [String(companyId)],
    );

    const res = await action.execute(companyId, {
      products: [],
      customers: [
        { name: 'Juan', phone: '3001112233' },
        { name: ' juan ', email: 'juan@dup.co' }, // dup en el batch
        { name: 'Ana' }, // ya existe
        { name: 'Maria', doc_number: '123', address: 'Calle 1' },
      ],
    });

    expect(res.customers.inserted).toBe(2); // Juan + Maria
    expect(res.customers.skippedDuplicate).toBe(1); // 2º juan
    expect(res.customers.skippedExisting).toBe(1); // Ana

    const maria = await ds.query(
      `SELECT name, doc_number, address, balance::float AS bal, advance_balance::float AS adv, points
         FROM customers WHERE company_id = $1 AND name = 'Maria'`,
      [String(companyId)],
    );
    expect(maria).toHaveLength(1);
    expect(maria[0].doc_number).toBe('123');
    expect(maria[0].bal).toBe(0);
    expect(maria[0].adv).toBe(0);
    expect(maria[0].points).toBe(0);
  });

  it('company destino inexistente → BadRequest', async () => {
    if (!ds) {
      return;
    }
    await expect(action.execute(999999999, { products: [], customers: [] })).rejects.toThrow(
      /no existe/,
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Suite B — HTTP con firma (action mockeado, sin BD)
// ═══════════════════════════════════════════════════════════════════════════

describe('MigrateCatalogController (e2e HTTP, firma AdminSignatureGuard)', () => {
  let app: INestApplication;
  let keys: KeyPairKeyObjectResult;
  const executeMock = jest.fn<Promise<MigrateCatalogResult>, [number, MigrateCatalogBody]>();

  const CANNED: MigrateCatalogResult = {
    products: {
      inserted: 0,
      skippedExisting: 0,
      skippedDuplicate: 0,
      skippedOrphan: 0,
      skippedInvalid: 0,
    },
    presentations: { inserted: 0, skipped: 0 },
    categories: { created: 0, reused: 0 },
    packagings: { created: 0, reused: 0 },
    customers: { inserted: 0, skippedExisting: 0, skippedDuplicate: 0 },
    prices: { inserted: 0 },
  };

  const PATH = '/superadmin/tenants/123/migrate-catalog';

  function signFor(path: string, ts: number): string {
    const bodyHash = createHash('sha256').update('').digest('hex');
    const message = `POST\n${path}\n${ts}\n${bodyHash}`;
    return edSign(null, Buffer.from(message, 'utf8'), keys.privateKey).toString('base64');
  }

  beforeAll(async () => {
    keys = generateKeyPairSync('ed25519');
    const publicKeyB64 = keys.publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
    executeMock.mockResolvedValue(CANNED);

    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [
            () => ({
              app: { adminSigning: { publicKey: publicKeyB64, maxSkewMs: 300000 } },
            }),
          ],
        }),
      ],
      controllers: [MigrateCatalogController],
      providers: [
        AdminSignatureGuard,
        { provide: MigrateCatalogAction, useValue: { execute: executeMock } },
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('firma válida → 201 y delega en el action con el companyId parseado', async () => {
    const ts = Date.now();
    const signature = signFor(PATH, ts);

    const res = await request(app.getHttpServer() as Server)
      .post(PATH)
      .set('x-kdevs-signature', signature)
      .set('x-kdevs-timestamp', String(ts))
      .set('x-kdevs-key-id', 'kdevs-1')
      .send({ products: [], customers: [] });

    expect(res.status).toBe(HttpStatus.CREATED);
    expect(res.body).toMatchObject({ products: { inserted: 0 } });
    expect(executeMock).toHaveBeenCalledWith(123, expect.objectContaining({ products: [] }));
  });

  it('firma inválida (mensaje adulterado) → 401', async () => {
    const ts = Date.now();
    // Firma un path DISTINTO → no valida contra el path real.
    const signature = signFor('/superadmin/tenants/999/migrate-catalog', ts);

    const res = await request(app.getHttpServer() as Server)
      .post(PATH)
      .set('x-kdevs-signature', signature)
      .set('x-kdevs-timestamp', String(ts))
      .send({ products: [], customers: [] });

    expect(res.status).toBe(HttpStatus.UNAUTHORIZED);
  });

  it('headers de firma ausentes → 401', async () => {
    const res = await request(app.getHttpServer() as Server)
      .post(PATH)
      .send({ products: [], customers: [] });

    expect(res.status).toBe(HttpStatus.UNAUTHORIZED);
  });

  it('timestamp fuera de la ventana anti-replay → 401', async () => {
    const staleTs = Date.now() - 10 * 60 * 1000; // 10 min > 5 min de skew
    const signature = signFor(PATH, staleTs);

    const res = await request(app.getHttpServer() as Server)
      .post(PATH)
      .set('x-kdevs-signature', signature)
      .set('x-kdevs-timestamp', String(staleTs))
      .send({ products: [], customers: [] });

    expect(res.status).toBe(HttpStatus.UNAUTHORIZED);
  });
});
