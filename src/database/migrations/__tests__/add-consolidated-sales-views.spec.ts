import type { QueryRunner } from 'typeorm';

import { AddConsolidatedSalesViews1747012360000 } from '../1747012360000-add-consolidated-sales-views';

/**
 * Las vistas del consolidado son ahora la fuente única de la verdad de "cuánto
 * vendí": si su SQL se degrada, TODOS los informes se equivocan a la vez. Este
 * test congela las cuatro decisiones que nacieron de descuadres reales medidos
 * en producción, para que nadie las deshaga sin darse cuenta:
 *
 *   1. El ajuste de las notas se agrega ANTES de unirse a la factura. Unir las
 *      líneas primero hacía que una nota de 3 líneas se restara 3 veces.
 *   2. Las líneas se identifican por `product_id`, nunca por su descripción: un
 *      producto renombrado aplicaba su nota una vez por cada nombre histórico.
 *   3. El cobro se topa contra el total UNA vez por factura y método; topar
 *      pago a pago contaba dos veces entera una venta con dos pagos y vuelto.
 *   4. La vista NO filtra ventas: expone `is_deleted` y `ticket_type` para que
 *      decida quien consulta. Lo que garantiza es que al excluir una venta se
 *      excluya también su nota — el error que restaba la nota de una venta que
 *      nunca se contó.
 */
describe('AddConsolidatedSalesViews1747012360000', () => {
  const buildRunner = (): { runner: QueryRunner; sql: () => string } => {
    // La firma se declara explícita: con `jest.fn(() => ...)` a secas, TS
    // infiere que no recibe argumentos y `call[0]` no compila.
    const query = jest.fn((_sql: string) => Promise.resolve([] as unknown[]));
    return {
      runner: { query } as unknown as QueryRunner,
      sql: () => query.mock.calls.map((call) => String(call[0])).join('\n'),
    };
  };

  const migration = new AddConsolidatedSalesViews1747012360000();

  const upSql = async (): Promise<string> => {
    const { runner, sql } = buildRunner();
    await migration.up(runner);
    return sql();
  };

  describe('up', () => {
    it('crea las cuatro vistas', async () => {
      const sql = await upSql();

      for (const view of [
        'v_sale_note_adjustments',
        'v_sales_consolidated',
        'v_sale_lines_consolidated',
        'v_sale_payments_consolidated',
      ]) {
        expect(sql).toContain(`CREATE OR REPLACE VIEW "${view}"`);
      }
    });

    it('la nota crédito RESTA y la débito SUMA', async () => {
      // La regla del negocio, escrita una sola vez en todo el sistema.
      const sql = await upSql();

      expect(sql).toMatch(/CASE WHEN cn\.note_type = 'DEBIT' THEN cn\.total ELSE -cn\.total END/);
    });

    it('agrega el ajuste por factura ANTES de unirlo (sin fan-out)', async () => {
      const sql = await upSql();
      const adjustments = sql.slice(sql.indexOf('v_sale_note_adjustments'));

      // El costo sale de las líneas, pero sumado dentro de un LATERAL.
      expect(adjustments).toMatch(/LATERAL[\s\S]*SUM\(cnl\.unit_cost \* cnl\.quantity\)/);
      expect(adjustments).toContain('GROUP BY cn.company_id, cn.sale_invoice_id');
    });

    it('ignora las notas anuladas', async () => {
      const sql = await upSql();

      expect(sql).toContain('WHERE cn.is_deleted = false');
    });

    it('consolida el total Y el costo (si no, la ganancia sale inflada)', async () => {
      const sql = await upSql();

      expect(sql).toContain('si.total + COALESCE(adj.total_adjustment, 0)');
      expect(sql).toContain('si.cost  + COALESCE(adj.cost_adjustment, 0)');
    });

    it('usa la fecha de VENTA, con la de registro como respaldo', async () => {
      // Es el criterio del módulo Resumen: un pedido cobrado días después
      // pertenece al mes en que se cobró.
      const sql = await upSql();

      expect(sql).toContain('COALESCE(si.sold_at, si.created_at)');
    });

    it('expone la venta sin filtrarla, para que decida quien consulta', async () => {
      // El flag de pedidos hace que a veces cuenten y a veces no; y hay
      // informes que necesitan listar las anuladas.
      const sql = await upSql();
      const consolidated = sql.slice(
        sql.indexOf('v_sales_consolidated'),
        sql.indexOf('v_sale_lines_consolidated'),
      );

      expect(consolidated).toContain('si.is_deleted');
      expect(consolidated).toContain('si.ticket_type');
      expect(consolidated).not.toMatch(/WHERE[\s\S]*si\.is_deleted = false/);
      expect(consolidated).not.toMatch(/WHERE[\s\S]*si\.ticket_type = 'SALE'/);
    });

    it('la venta se une a su nota por factura Y por company', async () => {
      // Sin el company_id en el JOIN, dos tenants podrían cruzarse.
      const sql = await upSql();

      expect(sql).toMatch(/adj\.sale_invoice_id = si\.id[\s\S]*adj\.company_id = si\.company_id/);
    });

    it('las líneas de la nota entran con su signo', async () => {
      const sql = await upSql();
      const lines = sql.slice(sql.indexOf('v_sale_lines_consolidated'));

      expect(lines).toMatch(/CASE WHEN cn\.note_type = 'DEBIT' THEN cnl\.quantity ELSE -cnl\.quantity END/);
      expect(lines).toMatch(/CASE WHEN cn\.note_type = 'DEBIT' THEN cnl\.total\s+ELSE -cnl\.total\s+END/);
    });

    it('las líneas se agrupan por producto, nunca por descripción', async () => {
      const sql = await upSql();
      const lines = sql.slice(sql.indexOf('v_sale_lines_consolidated'));

      expect(lines).toContain('cnl.product_id');
      expect(lines).toContain('sil.product_id');
      expect(lines).not.toContain('sil.description');
    });

    it('el cobro se topa contra el total una sola vez por factura', async () => {
      const sql = await upSql();
      const payments = sql.slice(sql.indexOf('v_sale_payments_consolidated'));

      expect(payments).toContain('LEAST(SUM(sp.amount), MAX(si.total))');
      expect(payments).not.toContain('SUM(LEAST(sp.amount');
      expect(payments).toContain('sp.is_voided = false');
    });
  });

  describe('down', () => {
    it('deshace las cuatro vistas sin tocar datos', async () => {
      // Es lo que hace segura la migración: revertirla no puede perder nada.
      const { runner, sql } = buildRunner();
      await migration.down(runner);

      for (const view of [
        'v_sale_payments_consolidated',
        'v_sale_lines_consolidated',
        'v_sales_consolidated',
        'v_sale_note_adjustments',
      ]) {
        expect(sql()).toContain(`DROP VIEW IF EXISTS "${view}"`);
      }
      expect(sql()).not.toMatch(/DELETE|TRUNCATE|DROP TABLE/i);
    });

    it('borra las vistas en orden inverso a sus dependencias', async () => {
      const { runner, sql } = buildRunner();
      await migration.down(runner);
      const emitted = sql();

      expect(emitted.indexOf('v_sales_consolidated')).toBeLessThan(
        emitted.indexOf('v_sale_note_adjustments'),
      );
    });
  });
});
