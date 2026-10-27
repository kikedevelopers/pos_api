import { randomUUID } from 'node:crypto';

import type { DataSource } from 'typeorm';

import { RunAiPurchaseToolAction } from '@/modules/ai/actions/run-ai-purchase-tool.action';
import type { AiToolRequestContext } from '@/modules/ai/internal/expense-tool-helpers';
import type { AiToolActor } from '@/modules/ai/internal/tool-catalog';
import { CreatePurchaseAction } from '@/modules/purchases/actions/create-purchase.action';

import {
  cleanupCompany,
  createDisposableCompany,
  insertOwnerUser,
  insertPackaging,
  insertProduct,
  tryInitDataSource,
} from './helpers/e2e-db';

/**
 * E2E (BD REAL pos_db) — Place lee una factura de proveedor y la registra
 * como COMPRA.
 *
 * Lo que se fija aquí (lo que NO puede fallar):
 *   - Antes de crear, VERIFICA cada ítem contra el inventario real: lo
 *     parecido se pregunta ("Encontré X, ¿es el mismo?") y no guarda nada; lo
 *     que no existe se excluye y se avisa.
 *   - Solo productos BASE comprables del propio negocio (nunca presentaciones,
 *     combos, archivados ni productos de otro tenant).
 *   - Nada se crea sin un "sí" explícito en una petición POSTERIOR; lo creado
 *     es EXACTAMENTE la vista previa (unidades por empaque, IVA, totales,
 *     deuda con el proveedor). Exactly-once aun con "sí" simultáneos.
 *   - Si el producto o su empaque cambian entre la vista previa y el "sí", no
 *     se crea nada.
 */

const COMPANY = '__E2E_AI_PURCHASE_TOOLS__';
const OTHER_COMPANY = '__E2E_AI_PURCHASE_TOOLS_OTHER__';

const canConnectPromise = tryInitDataSource();

interface PurchaseRow {
  id: string;
  supplier_id: string;
  supplier_name: string;
  subtotal: string;
  iva_total: string;
  total: string;
  status: string;
  invoice_number: string | null;
  invoice_date: string | null;
  client_operation_id: string | null;
  created_by_id: string;
}

interface PurchaseLineRow {
  product_id: string;
  packaging_id: string | null;
  packaging_value: string | null;
  packaging_qty: string;
  packaging_price: string;
  unit_qty: string;
  unit_price: string;
  iva_rate: string;
  total: string;
}

describe('Place · herramientas de documentos y compras (e2e pos_db)', () => {
  let ds: DataSource | null = null;
  let cid = 0;
  let otherCid = 0;
  let ownerId = 0;
  let employeeId = 0;
  let tools: RunAiPurchaseToolAction;
  let owner: AiToolActor;
  let adminEmployee: AiToolActor;
  const ids: Record<string, number> = {};

  const db = (): DataSource => {
    if (!ds) {
      throw new Error('Sin BD');
    }
    return ds;
  };
  const q = <T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> =>
    db().query(sql, params);

  const ctx = (
    current: string,
    previous: string | null = null,
    request_id: string = randomUUID(),
  ): AiToolRequestContext => ({
    request_id,
    current_user_message: current,
    previous_user_message: previous,
  });

  const purchases = (company = cid): Promise<PurchaseRow[]> =>
    q<PurchaseRow>(
      `SELECT id, supplier_id, supplier_name, subtotal::text, iva_total::text, total::text, status,
              invoice_number, to_char(invoice_date, 'YYYY-MM-DD') AS invoice_date,
              client_operation_id::text, created_by_id
         FROM purchases WHERE company_id = $1 ORDER BY id`,
      [String(company)],
    );

  const linesOf = (purchase_id: string): Promise<PurchaseLineRow[]> =>
    q<PurchaseLineRow>(
      `SELECT product_id, packaging_id, packaging_value::text, packaging_qty::text,
              packaging_price::text, unit_qty::text, unit_price::text, iva_rate::text, total::text
         FROM purchase_lines WHERE purchase_id = $1 ORDER BY id`,
      [purchase_id],
    );

  const pendingRows = (
    user_id = ownerId,
  ): Promise<Array<{ status: string; action_type: string; result_ref: string | null }>> =>
    q(
      `SELECT status, action_type, result_ref FROM ai_pending_actions
        WHERE company_id = $1 AND user_id = $2 ORDER BY id`,
      [String(cid), String(user_id)],
    );

  const supplierDebt = async (key: string): Promise<string> =>
    (
      await q<{ d: string }>(`SELECT accumulated_debt::text AS d FROM suppliers WHERE id = $1`, [
        ids[key],
      ])
    )[0].d;

  const addSupplier = async (
    company: number,
    key: string,
    legal_name: string,
    doc_number: string | null,
    archived = false,
  ): Promise<void> => {
    const [row] = await q<{ id: string }>(
      `INSERT INTO suppliers (company_id, legal_name, doc_number, is_archived)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [String(company), legal_name, doc_number, archived],
    );
    ids[key] = Number(row.id);
  };

  const addProduct = async (
    company: number,
    key: string,
    o: {
      name: string;
      cost: number;
      stock?: number;
      packaging?: [string, number];
      sku?: string;
      bar?: string;
      parent?: string;
      type?: 'SIMPLE' | 'COMBO';
      archived?: boolean;
    },
  ): Promise<void> => {
    const packaging_id = o.packaging
      ? await insertPackaging(db(), company, `${o.packaging[0]} ${key}`, o.packaging[1])
      : null;
    ids[key] = Number(
      await insertProduct(db(), company, {
        name: o.name,
        cost: o.cost,
        stock: o.stock ?? 0,
        packagingId: packaging_id,
        skuCode: o.sku ?? null,
        barCode: o.bar ?? null,
        parentId: o.parent ? String(ids[o.parent]) : null,
        productType: o.type ?? 'SIMPLE',
      }),
    );
    if (o.archived) {
      await q(`UPDATE products SET is_archived = true WHERE id = $1`, [ids[key]]);
    }
  };

  /** Factura "leída" por el modelo: 10 cajas de aceite + 2 bultos de arroz con IVA. */
  const INVOICE = {
    supplier: 'DISTRIBUIDORA LA ECONOMIA S.A.S.',
    supplier_document: '900.123.456-7',
    invoice_number: 'FE-1234',
    invoice_date: '2026-10-20',
    document_total: 545000,
    lines: [
      {
        description: 'ACEITE GIRASOL CAJA X 24',
        code: '7701001',
        quantity: 10,
        unit_cost: 36000,
        iva_rate: 19,
      },
      {
        description: 'ARROZ DIANA X BULTO',
        quantity: 2,
        unit_cost: 31000,
      },
    ],
  };
  const TRIGGER = 'crea una compra con esta factura';

  beforeAll(async () => {
    ds = await canConnectPromise;
    if (!ds) {
      return;
    }
    cid = await createDisposableCompany(ds, COMPANY);
    otherCid = await createDisposableCompany(ds, OTHER_COMPANY);
    ownerId = await insertOwnerUser(ds, cid, 'ai_purchases');
    employeeId = Number(
      (
        await q<{ id: string }>(
          `INSERT INTO users (name, lastname, email, password, type, company_id)
           VALUES ('Ana', 'Admin', $1, 'x', 'employee', $2) RETURNING id`,
          [`__e2e_ai_purchases_admin_${Date.now()}@example.test`, String(cid)],
        )
      )[0].id,
    );

    await addSupplier(cid, 'economia', 'La Economía', '900123456');
    await addSupplier(cid, 'andina', 'Distribuidora Andina', '800555444');
    await addSupplier(cid, 'archivado', 'Proveedor Archivado', '700111222', true);
    await addSupplier(otherCid, 'ajeno', 'La Economía', '900123456');

    await addProduct(cid, 'aceite_caja', {
      name: 'ACEITE GIRASOL CAJA X24',
      cost: 30000,
      stock: 5,
      packaging: ['CAJA X24', 24],
      bar: '7701001',
    });
    await addProduct(cid, 'aceite_unidad', {
      name: 'ACEITE GIRASOL X LITRO',
      cost: 1500,
      stock: 40,
      parent: 'aceite_caja',
    });
    await addProduct(cid, 'arroz_bulto', {
      name: 'ARROZ DIANA X BULTO',
      cost: 30000,
      stock: 3,
      packaging: ['BULTO', 50],
    });
    await addProduct(cid, 'arroz_libra', { name: 'ARROZ DIANA X LIBRA', cost: 650, stock: 80 });
    await addProduct(cid, 'panela', { name: 'PANELA REDONDA X 12', cost: 18000, stock: 2 });
    await addProduct(cid, 'combo', { name: 'COMBO DESAYUNO', cost: 5000, type: 'COMBO' });
    await addProduct(cid, 'viejo', { name: 'SAL REFISAL BULTO', cost: 20000, archived: true });
    await addProduct(otherCid, 'ajeno_prod', {
      name: 'DETERGENTE FAB X KILO',
      cost: 1,
      stock: 999,
    });

    tools = new RunAiPurchaseToolAction(ds, new CreatePurchaseAction(ds));
    owner = {
      isAdmin: true,
      permissions: new Set<string>(),
      canViewProfit: true,
      userId: ownerId,
      is_administrator: true,
      full_name: 'E2E Owner',
    };
    adminEmployee = {
      isAdmin: false,
      permissions: new Set<string>(['canAccessPurchase']),
      canViewProfit: false,
      userId: employeeId,
      is_administrator: true,
      full_name: 'Ana Admin',
    };
  });

  afterAll(async () => {
    if (!ds) {
      return;
    }
    for (const company of [cid, otherCid]) {
      const c = String(company);
      for (const table of [
        'ai_pending_actions',
        'purchase_payments',
        'purchase_credits',
        'purchase_lines',
        'purchases',
        'suppliers',
      ]) {
        await q(`DELETE FROM ${table} WHERE company_id = $1`, [c]);
      }
    }
    await cleanupCompany(ds, cid);
    await cleanupCompany(ds, otherCid);
    await ds.destroy();
  });

  beforeEach(async () => {
    if (!ds) {
      return;
    }
    const c = String(cid);
    for (const table of [
      'ai_pending_actions',
      'purchase_payments',
      'purchase_credits',
      'purchase_lines',
      'purchases',
    ]) {
      await q(`DELETE FROM ${table} WHERE company_id = $1`, [c]);
    }
    await q(`UPDATE suppliers SET accumulated_debt = 0 WHERE company_id = $1`, [c]);
    await q(
      `UPDATE products SET is_archived = false WHERE company_id = $1 AND name <> 'SAL REFISAL BULTO'`,
      [c],
    );
  });

  const itDb = (name: string, fn: () => Promise<void>): void => {
    it(name, async () => {
      if (!(await canConnectPromise)) {
        return; // sin BD en el runner: se omite limpio.
      }
      await fn();
    });
  };

  // ────────────────────────────────────────────────────────────────────────
  // match_document_products
  // ────────────────────────────────────────────────────────────────────────

  describe('match_document_products: cruce de un documento con el inventario', () => {
    itDb('encontrado, parecido y no encontrado, con el stock real', async () => {
      const result = await tools.matchDocumentProducts(cid, {
        items: [
          { description: 'ACEITE GIRASOL CAJA X24' },
          { description: 'ARROZ DIANA' },
          { description: 'DETERGENTE FAB X KILO' },
          { description: 'otro texto', code: '7701001' },
        ],
      });
      const items = result.items as Array<Record<string, unknown>>;

      expect(result).toMatchObject({ count: 4, found: 2, possible_matches: 1, not_found: 1 });
      expect(items[0]).toMatchObject({
        status: 'found',
        product: { name: 'ACEITE GIRASOL CAJA X24', stock: 5, packaging: 'CAJA X24 aceite_caja' },
      });
      // "ARROZ DIANA" tiene dos tamaños: nunca se elige uno solo.
      expect(items[1].status).toBe('possible_match');
      expect((items[1].candidates as Array<{ name: string }>).map((c) => c.name).sort()).toEqual([
        'ARROZ DIANA X BULTO',
        'ARROZ DIANA X LIBRA',
      ]);
      // El detergente es de OTRO negocio: no existe para este.
      expect(items[2]).toEqual({
        position: 3,
        description: 'DETERGENTE FAB X KILO',
        status: 'not_found',
      });
      // Por código de barras.
      expect(items[3]).toMatchObject({
        status: 'found',
        product: { name: 'ACEITE GIRASOL CAJA X24' },
      });
    });

    itDb(
      'consulta el inventario completo (incluye presentaciones), no solo lo comprable',
      async () => {
        const result = await tools.matchDocumentProducts(cid, {
          items: [{ description: 'ACEITE GIRASOL X LITRO' }],
        });
        expect((result.items as Array<Record<string, unknown>>)[0]).toMatchObject({
          status: 'found',
          product: { name: 'ACEITE GIRASOL X LITRO', stock: 40, parent: 'ACEITE GIRASOL CAJA X24' },
        });
      },
    );

    itDb('sin ítems devuelve error y no consulta nada raro', async () => {
      expect(await tools.matchDocumentProducts(cid, {})).toHaveProperty('error');
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  // Camino feliz
  // ────────────────────────────────────────────────────────────────────────

  describe('camino feliz: verifica, muestra la vista previa y crea con el "sí"', () => {
    itDb('prepara sin crear nada y la vista previa trae los datos exactos', async () => {
      const prepared = await tools.preparePurchase(cid, owner, INVOICE, ctx(TRIGGER));

      expect(prepared.status).toBe('confirmation_required');
      const summary = prepared.summary as Record<string, unknown>;
      expect(summary).toMatchObject({
        supplier: { name: 'La Economía', document: '900123456' },
        invoice_reference: 'FE-1234',
        subtotal: 422000,
        iva_total: 68400,
        total: 490400,
        excluded: [],
      });
      expect(summary.lines).toEqual([
        expect.objectContaining({
          product_name: 'ACEITE GIRASOL CAJA X24',
          packaging_value: 24,
          quantity: 10,
          unit_cost: 36000,
          iva_rate: 19,
          subtotal: 360000,
          iva_amount: 68400,
          total: 428400,
          source_description: 'ACEITE GIRASOL CAJA X 24',
          last_cost: null,
        }),
        expect.objectContaining({
          product_name: 'ARROZ DIANA X BULTO',
          packaging_value: 50,
          quantity: 2,
          unit_cost: 31000,
          total: 62000,
        }),
      ]);
      // El total de la factura ($ 545.000) no cuadra con lo leído: se advierte.
      expect(summary.warnings).toEqual([
        expect.stringMatching(/no coincide con el total de la factura/),
      ]);

      expect(await purchases()).toHaveLength(0);
      expect(await pendingRows()).toEqual([
        { status: 'PENDING', action_type: 'CREATE_PURCHASE', result_ref: null },
      ]);
    });

    itDb('el "sí" crea la compra idéntica, con su deuda al proveedor', async () => {
      await tools.preparePurchase(cid, owner, INVOICE, ctx(TRIGGER));
      const confirmed = await tools.confirmPurchase(cid, owner, ctx('sí, créala', TRIGGER));

      expect(confirmed.status).toBe('executed');
      const [purchase] = await purchases();
      expect(purchase).toMatchObject({
        supplier_id: String(ids.economia),
        supplier_name: 'La Economía',
        subtotal: '422000.00',
        iva_total: '68400.00',
        total: '490400.00',
        status: 'PENDING',
        invoice_number: 'FE-1234',
        invoice_date: '2026-10-20',
        created_by_id: String(ownerId),
      });
      expect(purchase.client_operation_id).not.toBeNull();
      expect(confirmed.purchase).toEqual({
        purchase_id: Number(purchase.id),
        purchase_number: expect.any(String),
        supplier_name: 'La Economía',
        lines_count: 2,
        total: 490400,
        status: 'PENDING',
      });

      const lines = await linesOf(purchase.id);
      expect(lines).toEqual([
        expect.objectContaining({
          product_id: String(ids.aceite_caja),
          packaging_value: '24.0000',
          packaging_qty: '10.0000',
          packaging_price: '36000.00',
          unit_qty: '240.0000',
          unit_price: '1500.0000',
          iva_rate: '19.00',
          total: '428400.00',
        }),
        expect.objectContaining({
          product_id: String(ids.arroz_bulto),
          unit_qty: '100.0000',
          unit_price: '620.0000',
          total: '62000.00',
        }),
      ]);
      const [credit] = await q<{ balance: string }>(
        `SELECT balance::text FROM purchase_credits WHERE purchase_id = $1`,
        [purchase.id],
      );
      expect(credit.balance).toBe('490400.00');
      expect(await supplierDebt('economia')).toBe('490400.00');
      expect(await pendingRows()).toEqual([
        { status: 'EXECUTED', action_type: 'CREATE_PURCHASE', result_ref: purchase.id },
      ]);
    });

    itDb('el rol Administrador también puede (firma la compra con su id)', async () => {
      await tools.preparePurchase(cid, adminEmployee, INVOICE, ctx(TRIGGER));
      const confirmed = await tools.confirmPurchase(cid, adminEmployee, ctx('sí', TRIGGER));
      expect(confirmed.status).toBe('executed');
      expect((await purchases())[0].created_by_id).toBe(String(employeeId));
    });

    itDb('compara con el costo de la última compra y advierte la desviación', async () => {
      await tools.preparePurchase(cid, owner, INVOICE, ctx(TRIGGER));
      await tools.confirmPurchase(cid, owner, ctx('sí', TRIGGER));

      // Segunda factura: el modelo leyó el aceite por UNIDAD ($ 1.500) y no por caja.
      const second = 'ingresa esta otra factura';
      const prepared = await tools.preparePurchase(
        cid,
        owner,
        {
          supplier: 'La Economía',
          lines: [{ description: 'ACEITE GIRASOL CAJA X24', quantity: 240, unit_cost: 1500 }],
        },
        ctx(second),
      );
      const summary = prepared.summary as {
        lines: Array<{ last_cost: number }>;
        warnings: string[];
      };
      expect(summary.lines[0].last_cost).toBe(36000);
      expect(summary.warnings).toEqual([
        expect.stringMatching(/muy distinto al de la última compra/),
      ]);
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  // Verificación antes de crear
  // ────────────────────────────────────────────────────────────────────────

  describe('verifica ANTES de crear: pregunta lo parecido y excluye lo que no existe', () => {
    itDb('un nombre parecido NO se elige solo: needs_input y nada guardado', async () => {
      const prepared = await tools.preparePurchase(
        cid,
        owner,
        {
          supplier: 'La Economía',
          lines: [
            { description: 'ACEITE GIRASOL CAJA X24', quantity: 1, unit_cost: 36000 },
            { description: 'PANELA REDONDA', quantity: 3, unit_cost: 18000 },
          ],
        },
        ctx(TRIGGER),
      );
      expect(prepared.status).toBe('needs_input');
      expect(prepared.possible_matches).toEqual([
        expect.objectContaining({
          description: 'PANELA REDONDA',
          status: 'possible_match',
          candidates: [expect.objectContaining({ name: 'PANELA REDONDA X 12', stock: 2 })],
        }),
      ]);
      expect(prepared.found).toEqual([
        { description: 'ACEITE GIRASOL CAJA X24', product: 'ACEITE GIRASOL CAJA X24' },
      ]);
      expect(await pendingRows()).toEqual([]);
    });

    itDb('otro tamaño o palabras de más también se preguntan (25 KG vs BULTO)', async () => {
      const prepared = await tools.preparePurchase(
        cid,
        owner,
        {
          supplier: 'La Economía',
          lines: [{ description: 'ARROZ DIANA BULTO 25KG', quantity: 2, unit_cost: 31000 }],
        },
        ctx(TRIGGER),
      );
      expect(prepared.status).toBe('needs_input');
      const [possible] = prepared.possible_matches as Array<{
        candidates: Array<{ name: string }>;
      }>;
      expect(possible.candidates.map((c) => c.name)).toContain('ARROZ DIANA X BULTO');
      expect(await pendingRows()).toEqual([]);
    });

    itDb('con el producto confirmado por el usuario (nombre exacto) sí prepara', async () => {
      const prepared = await tools.preparePurchase(
        cid,
        owner,
        {
          supplier: 'La Economía',
          lines: [
            {
              description: 'PANELA REDONDA',
              product: 'panela redonda x 12',
              quantity: 3,
              unit_cost: 18000,
            },
          ],
        },
        ctx('sí, es esa'),
      );
      expect(prepared.status).toBe('confirmation_required');
      expect(
        (prepared.summary as { lines: Array<Record<string, unknown>> }).lines[0],
      ).toMatchObject({
        product_name: 'PANELA REDONDA X 12',
        source_description: 'PANELA REDONDA',
      });
    });

    itDb('lo que no existe se excluye y se avisa; lo que el usuario descarta también', async () => {
      const prepared = await tools.preparePurchase(
        cid,
        owner,
        {
          supplier: 'La Economía',
          lines: [
            { description: 'ACEITE GIRASOL CAJA X24', quantity: 1, unit_cost: 36000 },
            { description: 'DETERGENTE FAB X KILO', quantity: 5, unit_cost: 9000 },
            { description: 'PANELA REDONDA', skip: true },
          ],
        },
        ctx(TRIGGER),
      );
      expect(prepared.status).toBe('confirmation_required');
      const summary = prepared.summary as Record<string, unknown>;
      expect(summary.lines).toHaveLength(1);
      expect(summary.excluded).toEqual([
        {
          description: 'DETERGENTE FAB X KILO',
          reason: expect.stringMatching(/No está en tu inventario/),
        },
        { description: 'PANELA REDONDA', reason: expect.stringMatching(/Indicaste que no es/) },
      ]);
      expect(summary.warnings).toEqual([
        expect.stringMatching(/2 ítems de la factura no se incluyen/),
      ]);
    });

    itDb('si ningún producto existe no prepara nada', async () => {
      const prepared = await tools.preparePurchase(
        cid,
        owner,
        {
          supplier: 'La Economía',
          lines: [{ description: 'DETERGENTE FAB X KILO', quantity: 1, unit_cost: 1 }],
        },
        ctx(TRIGGER),
      );
      expect(prepared.status).toBe('nothing_to_purchase');
      expect(await pendingRows()).toEqual([]);
    });

    itDb('presentaciones, combos y archivados nunca se compran', async () => {
      const prepared = await tools.preparePurchase(
        cid,
        owner,
        {
          supplier: 'La Economía',
          lines: [
            { description: 'ACEITE GIRASOL X LITRO', quantity: 1, unit_cost: 1500 },
            { description: 'COMBO DESAYUNO', quantity: 1, unit_cost: 5000 },
            { description: 'SAL REFISAL BULTO', quantity: 1, unit_cost: 20000 },
          ],
        },
        ctx(TRIGGER),
      );
      // La presentación del aceite solo puede proponer el BASE (la caja) como parecido.
      expect(prepared.status).toBe('needs_input');
      const possible = prepared.possible_matches as Array<{ candidates: Array<{ name: string }> }>;
      expect(possible.flatMap((p) => p.candidates.map((c) => c.name))).toEqual([
        'ACEITE GIRASOL CAJA X24',
      ]);
      expect(
        (prepared.excluded as Array<{ description: string }>).map((e) => e.description),
      ).toEqual(['COMBO DESAYUNO', 'SAL REFISAL BULTO']);
    });

    itDb('proveedor parecido se pregunta; desconocido o archivado se informa', async () => {
      const lines = [{ description: 'ACEITE GIRASOL CAJA X24', quantity: 1, unit_cost: 36000 }];
      const similar = await tools.preparePurchase(
        cid,
        owner,
        { supplier: 'ANDINA S.A.S.', lines },
        ctx(TRIGGER),
      );
      expect(similar).toMatchObject({
        status: 'needs_input',
        supplier: { status: 'possible_match', candidates: [{ name: 'Distribuidora Andina' }] },
      });

      const archived = await tools.preparePurchase(
        cid,
        owner,
        { supplier: 'Proveedor Archivado', supplier_document: '700111222', lines },
        ctx(TRIGGER),
      );
      expect(archived).toMatchObject({ status: 'needs_input', supplier: { status: 'not_found' } });
      expect(await pendingRows()).toEqual([]);
    });

    itDb('datos inválidos no preparan nada', async () => {
      expect(
        await tools.preparePurchase(
          cid,
          owner,
          { supplier: 'La Economía', lines: [] },
          ctx(TRIGGER),
        ),
      ).toMatchObject({ status: 'missing_data' });
      expect(
        await tools.preparePurchase(cid, owner, { lines: INVOICE.lines }, ctx(TRIGGER)),
      ).toMatchObject({ status: 'missing_data', missing: ['el proveedor'] });
      expect(
        await tools.preparePurchase(
          cid,
          owner,
          { ...INVOICE, lines: [{ description: 'ACEITE', quantity: 1, unit_cost: '36.000' }] },
          ctx(TRIGGER),
        ),
      ).toMatchObject({ status: 'invalid_data' });
      expect(
        await tools.preparePurchase(
          cid,
          owner,
          { ...INVOICE, invoice_date: '2026-02-30' },
          ctx(TRIGGER),
        ),
      ).toMatchObject({ status: 'invalid_data' });
      expect(await pendingRows()).toEqual([]);
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  // Confirmación forzada por el servidor
  // ────────────────────────────────────────────────────────────────────────

  describe('confirmación forzada por el servidor', () => {
    itDb('no se confirma en la misma petición que la preparó', async () => {
      const same = ctx(TRIGGER);
      await tools.preparePurchase(cid, owner, INVOICE, same);
      const result = await tools.confirmPurchase(cid, owner, {
        ...same,
        current_user_message: 'sí',
      });
      expect(result.status).toBe('awaiting_user_reply');
      expect(await purchases()).toHaveLength(0);
    });

    itDb('"sí pero son 12 cajas" no confirma y la pendiente vence', async () => {
      await tools.preparePurchase(cid, owner, INVOICE, ctx(TRIGGER));
      const result = await tools.confirmPurchase(cid, owner, ctx('sí pero son 12 cajas', TRIGGER));
      expect(result.status).toBe('confirmation_not_explicit');
      expect(await purchases()).toHaveLength(0);
      expect((await pendingRows())[0].status).toBe('EXPIRED');
    });

    itDb('un "sí" que no responde a ESA vista previa no confirma', async () => {
      await tools.preparePurchase(cid, owner, INVOICE, ctx(TRIGGER));
      const result = await tools.confirmPurchase(cid, owner, ctx('sí', 'otra cosa'));
      expect(result.status).toBe('stale_confirmation');
      expect(await purchases()).toHaveLength(0);
    });

    itDb('sin pendiente no crea nada', async () => {
      expect((await tools.confirmPurchase(cid, owner, ctx('sí', TRIGGER))).status).toBe(
        'no_pending_action',
      );
    });

    itDb('la pendiente de un usuario no la confirma otro', async () => {
      await tools.preparePurchase(cid, owner, INVOICE, ctx(TRIGGER));
      const other = await tools.confirmPurchase(cid, adminEmployee, ctx('sí', TRIGGER));
      expect(other.status).toBe('no_pending_action');
      expect(await purchases()).toHaveLength(0);
    });

    itDb('desde otro negocio no se confirma ni se ve', async () => {
      await tools.preparePurchase(cid, owner, INVOICE, ctx(TRIGGER));
      const other = await tools.confirmPurchase(otherCid, owner, ctx('sí', TRIGGER));
      expect(other.status).toBe('no_pending_action');
      expect(await purchases(otherCid)).toHaveLength(0);
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  // Exactly-once y revalidación
  // ────────────────────────────────────────────────────────────────────────

  describe('exactly-once y lo creado es lo que se mostró', () => {
    itDb('dos "sí" simultáneos crean UNA compra y suman la deuda una vez', async () => {
      await tools.preparePurchase(cid, owner, INVOICE, ctx(TRIGGER));
      const results = await Promise.all([
        tools.confirmPurchase(cid, owner, ctx('sí', TRIGGER)),
        tools.confirmPurchase(cid, owner, ctx('sí', TRIGGER)),
      ]);
      expect(results.filter((r) => r.status === 'executed')).toHaveLength(1);
      expect(await purchases()).toHaveLength(1);
      expect(await supplierDebt('economia')).toBe('490400.00');
    });

    itDb('si el producto se archiva antes del "sí", no se crea nada', async () => {
      await tools.preparePurchase(cid, owner, INVOICE, ctx(TRIGGER));
      await q(`UPDATE products SET is_archived = true WHERE id = $1`, [ids.arroz_bulto]);
      const result = await tools.confirmPurchase(cid, owner, ctx('sí', TRIGGER));
      expect(result.status).toBe('changed');
      expect(await purchases()).toHaveLength(0);
      expect((await pendingRows())[0].status).toBe('EXPIRED');
    });

    itDb('si cambia el empaque antes del "sí", no se crea nada', async () => {
      await tools.preparePurchase(cid, owner, INVOICE, ctx(TRIGGER));
      const [pk] = await q<{ packaging_id: string }>(
        `SELECT packaging_id FROM products WHERE id = $1`,
        [ids.aceite_caja],
      );
      await q(`UPDATE packagings SET value = 12 WHERE id = $1`, [pk.packaging_id]);
      try {
        const result = await tools.confirmPurchase(cid, owner, ctx('sí', TRIGGER));
        expect(result).toMatchObject({
          status: 'changed',
          message: expect.stringMatching(/empaque/),
        });
        expect(await purchases()).toHaveLength(0);
      } finally {
        await q(`UPDATE packagings SET value = 24 WHERE id = $1`, [pk.packaging_id]);
      }
    });

    itDb('si el proveedor se archiva antes del "sí", no se crea nada', async () => {
      await tools.preparePurchase(cid, owner, INVOICE, ctx(TRIGGER));
      await q(`UPDATE suppliers SET is_archived = true WHERE id = $1`, [ids.economia]);
      try {
        const result = await tools.confirmPurchase(cid, owner, ctx('sí', TRIGGER));
        expect(result.status).toBe('changed');
        expect(await purchases()).toHaveLength(0);
      } finally {
        await q(`UPDATE suppliers SET is_archived = false WHERE id = $1`, [ids.economia]);
      }
    });
  });
});
