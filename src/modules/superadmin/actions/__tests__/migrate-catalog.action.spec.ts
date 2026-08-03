import { BadRequestException } from '@nestjs/common';

import type { MigrateCatalogBody } from '../../internal/migrate-catalog.helpers';
import { MigrateCatalogAction } from '../migrate-catalog.action';

// ---------------------------------------------------------------------------
// Destino de la migración de catálogo.
//
// La pregunta que fijan estos tests: al migrar desde el detalle de una SUCURSAL,
// ¿los productos caen en la sucursal o en el negocio principal?
//
// El destino es SIEMPRE la company del path (`/superadmin/tenants/:id/...`), que
// es la que el panel tiene abierta. Nada en la migración deriva la company del
// owner — y eso es justo lo que hay que blindar, porque en una sucursal el owner
// pertenece a OTRA company (la principal) y basta un descuido para que el
// catálogo entero termine en el negocio equivocado.
//
// El owner sí se resuelve por membresía, pero solo para la AUTORÍA
// (`created_by`/`created_by_id`), nunca para el `company_id` de los datos.
// ---------------------------------------------------------------------------

/** Id de la sucursal abierta en el panel (destino real). */
const SUCURSAL = 14;
/** Id del negocio principal: NINGÚN dato debe aterrizar aquí. */
const PRINCIPAL = 13;
/** El owner vive en la company principal. */
const OWNER_ID = 13;

const BODY: MigrateCatalogBody = {
  meta: { businessName: 'Esencia & Grano', mongoBusinessId: 'abc123' },
  products: [
    {
      srcId: 'base-1',
      name: 'Café en grano',
      cost: 10000,
      stock: 5,
      parentSrcId: null,
      category: 'Bebidas',
      prices: [{ name: 'Normal', sale_price: 15000 }] as never,
    },
    {
      srcId: 'pres-1',
      name: 'Café en grano 500g',
      cost: 5000,
      stock: 10,
      parentSrcId: 'base-1',
      category: 'Bebidas',
      packaging: { name: 'Bolsa', value: 500 },
      prices: [{ name: 'Normal', sale_price: 8000 }] as never,
    },
  ],
  customers: [{ name: 'Cliente Uno', email: 'uno@correo.com' }],
};

interface Recorded {
  sql: string;
  params: unknown[];
}

function build(options: { companyExists?: boolean } = {}) {
  const recorded: Recorded[] = [];

  const runnerQuery = jest.fn(async (sql: string, params?: unknown[]) => {
    recorded.push({ sql, params: params ?? [] });
    const s = sql.trim();
    // Precargas del destino: sin nada existente, todo se inserta.
    if (s.startsWith('SELECT')) return [];
    if (s.includes('RETURNING id')) return [{ id: '999' }];
    return [];
  });

  const runner = {
    connect: jest.fn(),
    startTransaction: jest.fn(),
    commitTransaction: jest.fn(),
    rollbackTransaction: jest.fn(),
    release: jest.fn(),
    query: runnerQuery,
  };

  const dataSourceQuery = jest.fn(async (sql: string, params?: unknown[]) => {
    recorded.push({ sql, params: params ?? [] });
    if (sql.includes('FROM companies')) {
      return options.companyExists === false ? [] : [{ id: SUCURSAL }];
    }
    // resolveOwner: el owner se alcanza por membresía (vive en el principal).
    return [{ id: OWNER_ID, name: 'Enrique Pacheco' }];
  });

  const dataSource = {
    query: dataSourceQuery,
    createQueryRunner: jest.fn(() => runner),
  };

  return {
    action: new MigrateCatalogAction(dataSource as never),
    recorded,
    runner,
  };
}

/** Sentencias que escriben datos de negocio, con su tabla. */
function writesOf(recorded: Recorded[]): Array<{ table: string; params: unknown[] }> {
  const out: Array<{ table: string; params: unknown[] }> = [];
  for (const { sql, params } of recorded) {
    const m = /INSERT INTO (\w+)/.exec(sql);
    if (m) out.push({ table: m[1], params });
  }
  return out;
}

describe('MigrateCatalogAction · destino de la migración', () => {
  it('inserta TODO en la company del path, nunca en el negocio principal', async () => {
    const { action, recorded } = build();

    await action.execute(SUCURSAL, BODY);

    const writes = writesOf(recorded);
    expect(writes.length).toBeGreaterThan(0);
    for (const w of writes) {
      // En todas las tablas del catálogo, company_id es el PRIMER parámetro.
      expect(w.params[0]).toBe(SUCURSAL);
      expect(w.params[0]).not.toBe(PRINCIPAL);
    }
  });

  it('escribe en todas las tablas del catálogo con el id de la sucursal', async () => {
    const { action, recorded } = build();

    await action.execute(SUCURSAL, BODY);

    const byTable = new Map<string, unknown[][]>();
    for (const w of writesOf(recorded)) {
      byTable.set(w.table, [...(byTable.get(w.table) ?? []), w.params]);
    }

    for (const table of ['categories', 'packagings', 'products', 'product_prices', 'customers']) {
      const rows = byTable.get(table);
      // Si esto falla, el nombre de la tabla sale en el diff del array.
      expect([table, rows !== undefined]).toEqual([table, true]);
      for (const params of rows!) {
        expect([table, params[0]]).toEqual([table, SUCURSAL]);
      }
    }
  });

  it('el id del negocio principal NO aparece como company_id en ninguna escritura', async () => {
    // Red de seguridad frente a la confusión más cara posible: que el catálogo
    // de la sucursal termine mezclado en el inventario del principal.
    const { action, recorded } = build();

    await action.execute(SUCURSAL, BODY);

    for (const w of writesOf(recorded)) {
      expect(w.params[0]).not.toBe(PRINCIPAL);
    }
  });

  it('el dedupe también mira SOLO la sucursal (no reutiliza filas del principal)', async () => {
    // Si la precarga leyera el catálogo del principal, un producto que ya existe
    // allí se saltaría aquí y la sucursal se quedaría sin él.
    const { action, recorded } = build();

    await action.execute(SUCURSAL, BODY);

    const preloads = recorded.filter(
      (r) => r.sql.includes('WHERE company_id = $1') && r.sql.trim().startsWith('SELECT'),
    );
    expect(preloads.length).toBeGreaterThan(0);
    for (const p of preloads) {
      expect(p.params[0]).toBe(SUCURSAL);
    }
  });

  it('atribuye la autoría al owner heredado, sin llevarse su company', async () => {
    // El owner de una sucursal vive en el principal: se usa su NOMBRE e ID para
    // created_by, pero jamás su company_id como destino.
    const { action, recorded } = build();

    await action.execute(SUCURSAL, BODY);

    const products = writesOf(recorded).filter((w) => w.table === 'products');
    expect(products.length).toBeGreaterThan(0);
    for (const p of products) {
      expect(p.params).toContain('Enrique Pacheco');
      expect(p.params).toContain(OWNER_ID);
      expect(p.params[0]).toBe(SUCURSAL);
    }
  });

  it('resuelve el owner por membresía cuando la company no tiene uno propio', async () => {
    const { action, recorded } = build();

    await action.execute(SUCURSAL, BODY);

    const ownerQuery = recorded.find((r) => r.sql.includes('company_members'));
    expect(ownerQuery).toBeDefined();
    expect(ownerQuery!.sql).toContain('priority');
    expect(ownerQuery!.params[0]).toBe(SUCURSAL);
  });

  it('valida contra la company destino y aborta si no existe', async () => {
    const { action, runner } = build({ companyExists: false });

    await expect(action.execute(SUCURSAL, BODY)).rejects.toBeInstanceOf(BadRequestException);
    // Ni siquiera abre transacción: no se escribe nada en ningún lado.
    expect(runner.startTransaction).not.toHaveBeenCalled();
  });

  it('commitea la transacción al terminar bien', async () => {
    const { action, runner } = build();

    await action.execute(SUCURSAL, BODY);

    expect(runner.commitTransaction).toHaveBeenCalledTimes(1);
    expect(runner.rollbackTransaction).not.toHaveBeenCalled();
    expect(runner.release).toHaveBeenCalledTimes(1);
  });

  it('migrar al negocio principal sigue funcionando igual', async () => {
    const { action, recorded } = build();

    await action.execute(PRINCIPAL, BODY);

    for (const w of writesOf(recorded)) {
      expect(w.params[0]).toBe(PRINCIPAL);
    }
  });
});
