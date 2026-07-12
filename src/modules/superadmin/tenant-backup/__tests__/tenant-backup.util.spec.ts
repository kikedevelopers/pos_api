import {
  ImportRemapContext,
  canonicalize,
  computeTablesHash,
  partitionImportTables,
  quoteIdent,
  remapRowForImport,
  serializeValue,
  sortSelfReferential,
  topoSortTables,
} from '../tenant-backup.util';

describe('tenant-backup.util', () => {
  // ------------------------------------------------------------------------
  // quoteIdent
  // ------------------------------------------------------------------------
  describe('quoteIdent', () => {
    it('cita y escapa comillas dobles', () => {
      expect(quoteIdent('products')).toBe('"products"');
      expect(quoteIdent('we"ird')).toBe('"we""ird"');
    });
  });

  // ------------------------------------------------------------------------
  // canonicalize / computeTablesHash
  // ------------------------------------------------------------------------
  describe('computeTablesHash', () => {
    it('es independiente del orden de las claves', () => {
      const a = { products: [{ id: 1, name: 'x', price: '10' }] };
      const b = { products: [{ price: '10', name: 'x', id: 1 }] };
      expect(computeTablesHash(a)).toBe(computeTablesHash(b));
    });

    it('cambia si cambian los datos', () => {
      const a = { products: [{ id: 1, price: '10' }] };
      const b = { products: [{ id: 1, price: '11' }] };
      expect(computeTablesHash(a)).not.toBe(computeTablesHash(b));
    });

    it('trata Date y su ISO string como equivalentes (round-trip por la red)', () => {
      const iso = '2026-01-15T10:00:00.000Z';
      const withDate = { t: [{ id: 1, at: new Date(iso) }] };
      const withStr = { t: [{ id: 1, at: iso }] };
      expect(computeTablesHash(withDate)).toBe(computeTablesHash(withStr));
    });

    it('canonicalize normaliza null/undefined a null y ordena arrays sin reordenar', () => {
      expect(canonicalize(undefined)).toBeNull();
      expect(canonicalize([3, 1, 2])).toEqual([3, 1, 2]);
    });
  });

  // ------------------------------------------------------------------------
  // serializeValue
  // ------------------------------------------------------------------------
  describe('serializeValue', () => {
    it('re-stringifica columnas json', () => {
      expect(serializeValue({ a: 1 }, true)).toBe('{"a":1}');
      expect(serializeValue([1, 2], true)).toBe('[1,2]');
    });
    it('deja el resto intacto', () => {
      expect(serializeValue('99.5', false)).toBe('99.5');
      expect(serializeValue(42, false)).toBe(42);
    });
    it('null/undefined → null en ambos modos', () => {
      expect(serializeValue(null, true)).toBeNull();
      expect(serializeValue(undefined, false)).toBeNull();
    });
  });

  // ------------------------------------------------------------------------
  // topoSortTables
  // ------------------------------------------------------------------------
  describe('topoSortTables', () => {
    it('ordena padres antes que hijos', () => {
      const tables = ['sale_invoice_lines', 'sale_invoices', 'products'];
      const edges = [
        { child: 'sale_invoice_lines', parent: 'sale_invoices' },
        { child: 'sale_invoice_lines', parent: 'products' },
        { child: 'sale_invoices', parent: 'products' },
      ];
      const order = topoSortTables(tables, edges);
      expect(order.indexOf('products')).toBeLessThan(order.indexOf('sale_invoices'));
      expect(order.indexOf('sale_invoices')).toBeLessThan(order.indexOf('sale_invoice_lines'));
    });

    it('ignora aristas hacia tablas ausentes', () => {
      const order = topoSortTables(['a'], [{ child: 'a', parent: 'ausente' }]);
      expect(order).toEqual(['a']);
    });

    it('anexa remanentes en ciclos inesperados', () => {
      const order = topoSortTables(
        ['a', 'b'],
        [
          { child: 'a', parent: 'b' },
          { child: 'b', parent: 'a' },
        ],
      );
      expect(order.sort()).toEqual(['a', 'b']);
    });
  });

  // ------------------------------------------------------------------------
  // sortSelfReferential
  // ------------------------------------------------------------------------
  describe('sortSelfReferential', () => {
    it('emite el padre antes que sus hijos (producto base → presentaciones)', () => {
      const rows = [
        { id: 2, parent_id: 1 },
        { id: 3, parent_id: 2 },
        { id: 1, parent_id: null },
      ];
      const sorted = sortSelfReferential(rows, 'parent_id');
      const ids = sorted.map((r) => r.id);
      expect(ids.indexOf(1)).toBeLessThan(ids.indexOf(2));
      expect(ids.indexOf(2)).toBeLessThan(ids.indexOf(3));
      expect(sorted).toHaveLength(3);
    });

    it('tolera referencias a padres ausentes sin duplicar filas', () => {
      const rows = [{ id: 5, parent_id: 999 }];
      const sorted = sortSelfReferential(rows, 'parent_id');
      expect(sorted).toHaveLength(1);
      expect(sorted[0].id).toBe(5);
    });
  });

  // ------------------------------------------------------------------------
  // partitionImportTables
  // ------------------------------------------------------------------------
  describe('partitionImportTables', () => {
    it('conserva identidad/acceso, ignora shares y reemplaza el negocio', () => {
      const present = [
        'companies',
        'users',
        'subscriptions',
        'employees',
        'roles',
        'app_settings',
        'inventory_shares',
        'products',
        'sale_invoices',
        'customers',
      ];
      const { replace, preserved, skipped } = partitionImportTables(present);
      expect(skipped).toEqual(['inventory_shares']);
      expect(preserved).toEqual(
        expect.arrayContaining(['companies', 'users', 'subscriptions', 'employees', 'roles', 'app_settings']),
      );
      expect(replace).toEqual(['products', 'sale_invoices', 'customers']);
      // Ninguna tabla aparece en dos grupos.
      expect(replace).not.toContain('companies');
      expect(replace).not.toContain('users');
    });

    it('una tabla nueva desconocida cae en el conjunto reemplazable', () => {
      const { replace } = partitionImportTables(['tabla_futura']);
      expect(replace).toEqual(['tabla_futura']);
    });
  });

  // ------------------------------------------------------------------------
  // remapRowForImport (núcleo del import cross-company)
  // ------------------------------------------------------------------------
  describe('remapRowForImport', () => {
    const baseCtx = (over: Partial<ImportRemapContext> = {}): ImportRemapContext => ({
      targetCompanyId: 9,
      ownerUserId: 90,
      ownerName: 'RICHARD BASTIDAS',
      pkColumn: 'id',
      fkParentByColumn: {},
      jsonColumns: new Set<string>(),
      idMaps: new Map(),
      ...over,
    });

    const pick = (
      result: { columns: string[]; values: unknown[] },
      col: string,
    ): unknown => result.values[result.columns.indexOf(col)];

    it('omite la PK (la BD asigna un id nuevo)', () => {
      const res = remapRowForImport({ id: 100, total: '5' }, baseCtx());
      expect(res.columns).not.toContain('id');
      expect(res.columns).toEqual(['total']);
    });

    it('reapunta company_id (FK→companies) al destino', () => {
      const res = remapRowForImport(
        { id: 1, company_id: 13 },
        baseCtx({ fkParentByColumn: { company_id: 'companies' } }),
      );
      expect(pick(res, 'company_id')).toBe(9);
    });

    it('reapunta las FK→users al owner del destino y conserva null', () => {
      const withUser = remapRowForImport(
        { id: 1, user_id: 15 },
        baseCtx({ fkParentByColumn: { user_id: 'users' } }),
      );
      expect(pick(withUser, 'user_id')).toBe(90);

      const nullUser = remapRowForImport(
        { id: 1, user_id: null },
        baseCtx({ fkParentByColumn: { user_id: 'users' } }),
      );
      expect(pick(nullUser, 'user_id')).toBeNull();
    });

    it('remapea una FK a otra tabla de negocio con el nuevo id del padre', () => {
      const idMaps = new Map([['customers', new Map([['50', 777]])]]);
      const res = remapRowForImport(
        { id: 1, customer_id: 50 },
        baseCtx({ fkParentByColumn: { customer_id: 'customers' }, idMaps }),
      );
      expect(pick(res, 'customer_id')).toBe(777);
    });

    it('si el padre no se importó, la FK queda null (la BD descarta si es NOT NULL)', () => {
      const res = remapRowForImport(
        { id: 1, customer_id: 50 },
        baseCtx({ fkParentByColumn: { customer_id: 'customers' }, idMaps: new Map([['customers', new Map()]]) }),
      );
      expect(pick(res, 'customer_id')).toBeNull();
    });

    it('reapunta la auditoría (created_by_id → owner, created_by → nombre owner)', () => {
      const res = remapRowForImport(
        { id: 1, created_by_id: 13, created_by: 'DIANA BOLAÑOS', updated_by_id: 15, updated_by: 'OTRO' },
        baseCtx(),
      );
      expect(pick(res, 'created_by_id')).toBe(90);
      expect(pick(res, 'created_by')).toBe('RICHARD BASTIDAS');
      expect(pick(res, 'updated_by_id')).toBe(90);
      expect(pick(res, 'updated_by')).toBe('RICHARD BASTIDAS');
    });

    it('conserva la auditoría null como null', () => {
      const res = remapRowForImport({ id: 1, created_by_id: null, created_by: null }, baseCtx());
      expect(pick(res, 'created_by_id')).toBeNull();
      expect(pick(res, 'created_by')).toBeNull();
    });

    it('re-stringifica columnas json y deja intactas las demás', () => {
      const res = remapRowForImport(
        { id: 1, meta: { a: 1 }, total: '99.5' },
        baseCtx({ jsonColumns: new Set(['meta']) }),
      );
      expect(pick(res, 'meta')).toBe('{"a":1}');
      expect(pick(res, 'total')).toBe('99.5');
    });

    it('sin owner (owner null) las referencias de usuario quedan null', () => {
      const res = remapRowForImport(
        { id: 1, user_id: 15, created_by_id: 13 },
        baseCtx({ ownerUserId: null, ownerName: null, fkParentByColumn: { user_id: 'users' } }),
      );
      expect(pick(res, 'user_id')).toBeNull();
      expect(pick(res, 'created_by_id')).toBeNull();
    });

    it('sin pkColumn (tabla sin PK simple) no omite ninguna columna', () => {
      const res = remapRowForImport({ a: 1, b: 2 }, baseCtx({ pkColumn: null }));
      expect(res.columns.sort()).toEqual(['a', 'b']);
    });
  });
});
