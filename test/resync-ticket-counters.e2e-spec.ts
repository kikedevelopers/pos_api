import type { DataSource } from 'typeorm';

import { ResyncTicketCounters1747012180000 } from '@/database/migrations/1747012180000-resync-ticket-counters';
import { IncrementTicketNumberAction } from '@/modules/ticket-settings/actions/increment-ticket-number.action';
import { TicketSettingType } from '@/modules/ticket-settings/entities/ticket-setting.entity';
import { resyncTicketCounters } from '@/modules/ticket-settings/internal/resync-ticket-counters';

import { tryInitDataSource, createDisposableCompany, cleanupCompany } from './helpers/e2e-db';

/**
 * e2e de la resincronización de folios contra pos_db (SQL real, no mocks).
 *
 * Reproduce el bug que dejaba el POS bloqueado: `ImportTenantAction` reemplaza
 * las ventas con las del respaldo (folios del ORIGEN) pero conserva los
 * `ticket_settings` del destino, así que el contador queda por detrás de folios
 * YA EMITIDOS y la siguiente venta revienta con 23505 sobre
 * `idx_sale_invoices_company_ticket_number_unique` — de forma PERMANENTE,
 * porque el rollback deshace el incremento y el reintento pide el mismo folio.
 *
 * Patrón anti-CI-rojo: si pos_db no está disponible, `tryInitDataSource`
 * devuelve null y los casos se omiten en limpio.
 */
describe('Resincronización de folios (e2e, pos_db)', () => {
  let ds: DataSource | null = null;
  const createdCompanies: number[] = [];

  beforeAll(async () => {
    ds = await tryInitDataSource();
  });

  afterAll(async () => {
    if (!ds) {
      return;
    }
    for (const id of createdCompanies) {
      const cid = String(id);
      // `cleanupCompany` no conoce estas tablas. Orden por FKs: hijos → padres.
      await ds.query(`DELETE FROM purchase_payments WHERE company_id = $1`, [cid]);
      await ds.query(`DELETE FROM purchases WHERE company_id = $1`, [cid]);
      await ds.query(`DELETE FROM suppliers WHERE company_id = $1`, [cid]);
      await ds.query(`DELETE FROM credit_notes WHERE company_id = $1`, [cid]);
      await ds.query(`DELETE FROM sale_invoices WHERE company_id = $1`, [cid]);
      await ds.query(`DELETE FROM ticket_settings WHERE company_id = $1`, [cid]);
      await cleanupCompany(ds, id);
    }
    await ds.destroy();
  });

  const maybe = (name: string, fn: () => Promise<void>): void =>
    void it(name, async () => {
      if (!ds) {
        console.warn('pos_db no disponible — test omitido');
        return;
      }
      await fn();
    });

  /** Company desechable con sus 6 contadores en 0 (espejo del seed real). */
  const newCompany = async (name: string): Promise<number> => {
    const id = await createDisposableCompany(ds!, `__e2e_resync_${name}`);
    createdCompanies.push(id);
    for (const type of Object.values(TicketSettingType)) {
      await ds!.query(
        `INSERT INTO ticket_settings (company_id, ticket_type, current_number, prefix)
         VALUES ($1, $2, 0, 'PED')`,
        [String(id), type],
      );
    }
    return id;
  };

  const setCounter = async (
    companyId: number,
    type: TicketSettingType,
    value: number,
  ): Promise<void> => {
    await ds!.query(
      `UPDATE ticket_settings SET current_number = $3 WHERE company_id = $1 AND ticket_type = $2`,
      [String(companyId), type, value],
    );
  };

  const counterOf = async (companyId: number, type: TicketSettingType): Promise<number> => {
    const rows: Array<{ current_number: number }> = await ds!.query(
      `SELECT current_number FROM ticket_settings WHERE company_id = $1 AND ticket_type = $2`,
      [String(companyId), type],
    );
    return Number(rows[0].current_number);
  };

  const insertInvoice = async (
    companyId: number,
    ticketNumber: string,
    saleNumber: string | null = null,
  ): Promise<void> => {
    await ds!.query(
      `INSERT INTO sale_invoices (company_id, ticket_type, ticket_number, sale_number)
       VALUES ($1, $2, $3, $4)`,
      [String(companyId), saleNumber === null ? 'ORDER' : 'SALE', ticketNumber, saleNumber],
    );
  };

  const insertNote = async (
    companyId: number,
    noteNumber: string,
    noteType: 'CREDIT' | 'DEBIT',
  ): Promise<void> => {
    // `sale_invoice_id` es NOT NULL con FK: la nota cuelga de una venta real.
    const inv: Array<{ id: string }> = await ds!.query(
      `INSERT INTO sale_invoices (company_id, ticket_type, ticket_number)
       VALUES ($1, 'ORDER', $2) RETURNING id`,
      [String(companyId), `__base_${noteNumber}`],
    );
    // `chk_credit_notes_type_operation_consistency`: CREDIT ⇒ FULL_VOID |
    // PARTIAL_VOID; DEBIT ⇒ ADDITION.
    await ds!.query(
      `INSERT INTO credit_notes (company_id, sale_invoice_id, note_number, note_type, operation_type)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        String(companyId),
        inv[0].id,
        noteNumber,
        noteType,
        noteType === 'CREDIT' ? 'FULL_VOID' : 'ADDITION',
      ],
    );
  };

  const insertPurchase = async (companyId: number, purchaseNumber: string): Promise<string> => {
    const sup: Array<{ id: string }> = await ds!.query(
      `INSERT INTO suppliers (company_id, legal_name) VALUES ($1, 'E2E Proveedor') RETURNING id`,
      [String(companyId)],
    );
    const p: Array<{ id: string }> = await ds!.query(
      `INSERT INTO purchases (company_id, purchase_number, supplier_id, supplier_name)
       VALUES ($1, $2, $3, 'E2E Proveedor') RETURNING id`,
      [String(companyId), purchaseNumber, sup[0].id],
    );
    return p[0].id;
  };

  const runMigration = async (): Promise<void> => {
    const runner = ds!.createQueryRunner();
    await runner.connect();
    try {
      await new ResyncTicketCounters1747012180000().up(runner);
    } finally {
      await runner.release();
    }
  };

  // ─── El bug real, de punta a punta ──────────────────────────────────────

  maybe(
    'el contador por detrás bloquea la venta; tras resincronizar, vuelve a emitir',
    async () => {
      const c = await newCompany('bloqueo');
      // Estado que dejaba el import: folios emitidos hasta 6296 (los del
      // respaldo) y contador del destino clavado en 4070.
      await insertInvoice(c, 'PED-4070');
      await insertInvoice(c, 'PED-4071'); // el folio que el contador va a pedir
      await insertInvoice(c, 'PED-6296');
      await setCounter(c, TicketSettingType.ORDER, 4070);

      const action = new IncrementTicketNumberAction();

      // ANTES: el contador emite PED-4071, que ya existe → 23505 y venta perdida.
      await expect(
        ds!.transaction(async (manager) => {
          const t = await action.execute(manager, c, TicketSettingType.ORDER);
          await manager.query(
            `INSERT INTO sale_invoices (company_id, ticket_type, ticket_number) VALUES ($1, 'ORDER', $2)`,
            [String(c), t.formatted],
          );
        }),
      ).rejects.toMatchObject({ code: '23505' });

      // El rollback deshizo el incremento: el contador sigue clavado → reintentar
      // es inútil, que es justo por lo que el POS quedaba bloqueado para siempre.
      expect(await counterOf(c, TicketSettingType.ORDER)).toBe(4070);

      await ds!.transaction(async (manager) => resyncTicketCounters(manager, c));

      // DESPUÉS: el contador arranca sobre el folio más alto REAL → sin colisión.
      await ds!.transaction(async (manager) => {
        const t = await action.execute(manager, c, TicketSettingType.ORDER);
        expect(t.number).toBe(6297);
        await manager.query(
          `INSERT INTO sale_invoices (company_id, ticket_type, ticket_number) VALUES ($1, 'ORDER', $2)`,
          [String(c), t.formatted],
        );
      });
    },
  );

  // ─── Cada contador contra su fuente ─────────────────────────────────────

  maybe('ORDER cuenta TODAS las facturas (el folio del ticket nace ORDER)', async () => {
    const c = await newCompany('order');
    await insertInvoice(c, 'PED-010');
    // Una venta ya cobrada también consumió folio ORDER en su día.
    await insertInvoice(c, 'PED-055', 'VTA-030');

    await ds!.transaction(async (manager) => resyncTicketCounters(manager, c));

    expect(await counterOf(c, TicketSettingType.ORDER)).toBe(55);
  });

  maybe('SALE lee sale_number e ignora los pedidos sin cobrar (NULL)', async () => {
    const c = await newCompany('sale');
    await insertInvoice(c, 'PED-100', 'VTA-040');
    await insertInvoice(c, 'PED-101'); // pedido vivo: sale_number NULL

    await ds!.transaction(async (manager) => resyncTicketCounters(manager, c));

    expect(await counterOf(c, TicketSettingType.SALE)).toBe(40);
    expect(await counterOf(c, TicketSettingType.ORDER)).toBe(101);
  });

  maybe('CREDIT_NOTE y DEBIT_NOTE se separan por note_type', async () => {
    const c = await newCompany('notas');
    await insertNote(c, 'NC-044', 'CREDIT');
    await insertNote(c, 'ND-018', 'DEBIT');

    await ds!.transaction(async (manager) => resyncTicketCounters(manager, c));

    // Sin el filtro por note_type ambos contadores subirían a 44.
    expect(await counterOf(c, TicketSettingType.CREDIT_NOTE)).toBe(44);
    expect(await counterOf(c, TicketSettingType.DEBIT_NOTE)).toBe(18);
  });

  maybe('PURCHASE y PURCHASE_PAYMENT leen sus propias tablas', async () => {
    const c = await newCompany('compras');
    const purchaseId = await insertPurchase(c, 'COMP-005');
    await ds!.query(
      `INSERT INTO purchase_payments (company_id, purchase_id, payment_number, payment_method, amount)
       VALUES ($1, $2, 'APC-004', 'CASH', 100)`,
      [String(c), purchaseId],
    );

    await ds!.transaction(async (manager) => resyncTicketCounters(manager, c));

    expect(await counterOf(c, TicketSettingType.PURCHASE)).toBe(5);
    expect(await counterOf(c, TicketSettingType.PURCHASE_PAYMENT)).toBe(4);
  });

  // ─── Casos límite ───────────────────────────────────────────────────────

  maybe('NO retrocede un contador que ya va por delante', async () => {
    const c = await newCompany('adelantado');
    await insertInvoice(c, 'PED-010');
    await setCounter(c, TicketSettingType.ORDER, 500);

    const resynced = await ds!.transaction(async (manager) => resyncTicketCounters(manager, c));

    // Bajarlo a 10 reusaría folios ya emitidos.
    expect(resynced).toEqual([]);
    expect(await counterOf(c, TicketSettingType.ORDER)).toBe(500);
  });

  maybe('es idempotente: la segunda corrida no cambia nada', async () => {
    const c = await newCompany('idempotente');
    await insertInvoice(c, 'PED-077');

    const first = await ds!.transaction(async (manager) => resyncTicketCounters(manager, c));
    expect(first).toHaveLength(1);
    expect(await counterOf(c, TicketSettingType.ORDER)).toBe(77);

    const second = await ds!.transaction(async (manager) => resyncTicketCounters(manager, c));
    expect(second).toEqual([]);
    expect(await counterOf(c, TicketSettingType.ORDER)).toBe(77);
  });

  maybe('una company sin data deja sus contadores intactos', async () => {
    const c = await newCompany('vacia');

    const resynced = await ds!.transaction(async (manager) => resyncTicketCounters(manager, c));

    expect(resynced).toEqual([]);
    for (const type of Object.values(TicketSettingType)) {
      expect(await counterOf(c, type)).toBe(0);
    }
  });

  maybe('NO subestima con prefijos ajenos ni sufijos numéricos', async () => {
    const c = await newCompany('formatos');
    // Folios de otra empresa (import cross-company) + sufijo numérico: se toma
    // el mayor segmento numérico, así que jamás queda por debajo del folio real.
    await insertInvoice(c, 'OTRAEMPRESA-320-2026');
    await insertInvoice(c, '145'); // sin prefix
    await insertInvoice(c, 'SIN-DIGITOS'); // no aporta número: se ignora

    await ds!.transaction(async (manager) => resyncTicketCounters(manager, c));

    // 2026 (sufijo) > 320: sobreestimar solo salta números, nunca colisiona.
    expect(await counterOf(c, TicketSettingType.ORDER)).toBe(2026);
  });

  maybe('el folio queda intacto si ninguna fila tiene dígitos', async () => {
    const c = await newCompany('sin_digitos');
    await insertInvoice(c, 'PED-ABC');

    const resynced = await ds!.transaction(async (manager) => resyncTicketCounters(manager, c));

    expect(resynced).toEqual([]);
    expect(await counterOf(c, TicketSettingType.ORDER)).toBe(0);
  });

  // ─── Migración correctiva (global) ──────────────────────────────────────

  maybe('la migración cura la company rota sin tocar las sanas ni otras companies', async () => {
    const rota = await newCompany('mig_rota');
    const sana = await newCompany('mig_sana');

    await insertInvoice(rota, 'PED-900');
    await setCounter(rota, TicketSettingType.ORDER, 100); // desincronizada

    await insertInvoice(sana, 'PED-050');
    await setCounter(sana, TicketSettingType.ORDER, 50); // al día

    await runMigration();

    expect(await counterOf(rota, TicketSettingType.ORDER)).toBe(900);
    // Aislamiento multi-tenant: el UPDATE global cruza company_id, así que los
    // folios de `rota` no pueden empujar el contador de `sana`.
    expect(await counterOf(sana, TicketSettingType.ORDER)).toBe(50);
  });
});
