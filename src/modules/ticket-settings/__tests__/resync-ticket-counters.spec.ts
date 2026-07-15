import type { EntityManager } from 'typeorm';

import { TicketSettingType } from '../entities/ticket-setting.entity';
import {
  TICKET_COUNTER_SOURCES,
  buildResyncTicketCountersSql,
  resyncTicketCounters,
} from '../internal/resync-ticket-counters';

/**
 * Unitarios del constructor del SQL de resincronización. La prueba de que el
 * SQL hace lo correcto contra Postgres vive en el e2e
 * (`test/resync-ticket-counters.e2e-spec.ts`); aquí se blindan las propiedades
 * ESTRUCTURALES que, si se rompen, reintroducen el bug del folio duplicado.
 */
describe('resync-ticket-counters', () => {
  describe('TICKET_COUNTER_SOURCES', () => {
    it('cubre TODOS los tipos que emiten folio', () => {
      const covered = new Set(TICKET_COUNTER_SOURCES.map((s) => s.type));
      // Si mañana se agrega un tipo nuevo a `TicketSettingType` que emita folio,
      // este test obliga a declarar su fuente aquí (o el contador nunca se
      // resincroniza y su company acaba bloqueada).
      expect(covered).toEqual(new Set(Object.values(TicketSettingType)));
    });

    it('discrimina notas crédito y débito, que comparten tabla y columna', () => {
      const credit = TICKET_COUNTER_SOURCES.find((s) => s.type === TicketSettingType.CREDIT_NOTE);
      const debit = TICKET_COUNTER_SOURCES.find((s) => s.type === TicketSettingType.DEBIT_NOTE);

      // Sin el filtro por `note_type` ambos contadores leerían las mismas filas
      // y el de notas débito subiría al folio de una nota crédito.
      expect(credit).toMatchObject({
        table: 'credit_notes',
        column: 'note_number',
        where: "note_type = 'CREDIT'",
      });
      expect(debit).toMatchObject({
        table: 'credit_notes',
        column: 'note_number',
        where: "note_type = 'DEBIT'",
      });
    });

    it('lee el folio del ticket de `ticket_number` y el de venta de `sale_number`', () => {
      const order = TICKET_COUNTER_SOURCES.find((s) => s.type === TicketSettingType.ORDER);
      const sale = TICKET_COUNTER_SOURCES.find((s) => s.type === TicketSettingType.SALE);

      // El ticket nace SIEMPRE del contador ORDER → cuentan TODAS las filas,
      // sin filtrar por ticket_type (una venta cobrada también consumió folio).
      expect(order).toMatchObject({
        table: 'sale_invoices',
        column: 'ticket_number',
        where: null,
      });
      expect(sale).toMatchObject({
        table: 'sale_invoices',
        column: 'sale_number',
        where: 'sale_number IS NOT NULL',
      });
    });
  });

  describe('buildResyncTicketCountersSql', () => {
    it('NUNCA retrocede un contador: solo actualiza si el folio real es mayor', () => {
      // La guarda que hace la operación idempotente y evita reusar folios ya
      // emitidos. Sin ella, un import con menos data bajaría el contador.
      expect(buildResyncTicketCountersSql(true)).toContain('maxes.n > ts.current_number');
      expect(buildResyncTicketCountersSql(false)).toContain('maxes.n > ts.current_number');
    });

    it('acota a la company vía $1 cuando es scoped', () => {
      const sql = buildResyncTicketCountersSql(true);
      // Una fuente por tipo de folio: todas deben filtrar por company.
      const filters = sql.match(/company_id = \$1/g) ?? [];
      expect(filters).toHaveLength(TICKET_COUNTER_SOURCES.length);
    });

    it('no filtra por company cuando es global (migración correctiva)', () => {
      expect(buildResyncTicketCountersSql(false)).not.toContain('$1');
    });

    it('empareja el contador con su company: el UPDATE cruza company_id y ticket_type', () => {
      // Sin AMBAS condiciones el UPDATE global pisaría contadores de otras
      // companies con folios ajenos.
      const sql = buildResyncTicketCountersSql(false);
      expect(sql).toContain('ts.company_id = maxes.company_id');
      expect(sql).toContain('ts.ticket_type = maxes.ticket_type');
    });

    it('extrae el número como el máximo de los segmentos numéricos del folio', () => {
      const sql = buildResyncTicketCountersSql(true);
      // Nunca subestimar es lo que evita la colisión: se parte por '-' y se toma
      // el mayor segmento numérico, acotado a 15 dígitos para no reventar bigint.
      expect(sql).toContain("regexp_split_to_array(sale_invoices.ticket_number, '-')");
      expect(sql).toContain("seg ~ '^[0-9]{1,15}$'");
    });

    it('ignora las filas sin ningún segmento numérico', () => {
      expect(buildResyncTicketCountersSql(true)).toContain('WHERE n IS NOT NULL');
    });
  });

  describe('resyncTicketCounters', () => {
    it('pasa el companyId como string y devuelve los contadores adelantados', async () => {
      const rows = [
        { company_id: '13', ticket_type: TicketSettingType.ORDER, current_number: 6296 },
      ];
      const manager = { query: jest.fn().mockResolvedValue(rows) } as unknown as EntityManager;

      const result = await resyncTicketCounters(manager, 13);

      expect(result).toEqual(rows);
      const [sql, params] = (manager.query as jest.Mock).mock.calls[0] as [string, unknown[]];
      expect(sql).toBe(buildResyncTicketCountersSql(true));
      // `company_id` es bigint: TypeORM lo mapea a string en toda la base.
      expect(params).toEqual(['13']);
    });

    it('devuelve vacío cuando ya estaban al día', async () => {
      const manager = { query: jest.fn().mockResolvedValue([]) } as unknown as EntityManager;

      await expect(resyncTicketCounters(manager, 13)).resolves.toEqual([]);
    });
  });
});
