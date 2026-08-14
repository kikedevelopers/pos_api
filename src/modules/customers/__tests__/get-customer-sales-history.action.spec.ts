import type { Repository } from 'typeorm';

import type { Customer } from '@/modules/customers/entities/customer.entity';

import { GetCustomerSalesHistoryAction } from '../actions/get-customer-sales-history.action';

/**
 * El historial de compras de un cliente alimenta también el modal de créditos
 * del POS, que es donde se le dice a alguien cuánto debe. Devolvía el total
 * PERSISTIDO de la factura "por paridad con el offline", así que una venta de
 * 200.000 a la que se le quitaron 50.000 seguía apareciendo en 200.000.
 *
 * Caso real de la BD de producción: el cliente 11793 veía PED-2607 en $27.000
 * cuando la venta terminó en $53.946 tras la nota débito.
 */
describe('GetCustomerSalesHistoryAction · cifras consolidadas', () => {
  let action: GetCustomerSalesHistoryAction;
  let querySpy: jest.Mock;

  const row = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    id: '312926',
    sale_number: null,
    ticket_number: 'PED-2607',
    ticket_type: 'SALE',
    created_at: new Date('2026-05-04T15:00:00.000Z'),
    created_by: 'DAYANA',
    total: '53946',
    cost: '23405',
    profit: '30541',
    margin: '56.61',
    payment_method: 'CASH',
    is_credit: false,
    credit_status: null,
    credit_balance: null,
    credit_paid: null,
    credit_total: null,
    products_concat: 'ANIS ESTRELLADO X GRAMO',
    ...over,
  });

  const build = (rows: unknown[] = []): void => {
    querySpy = jest.fn(() => Promise.resolve(rows));
    const repoMock = {
      query: querySpy,
      manager: { findOne: jest.fn(() => Promise.resolve({ id: '11793' })) },
    } as unknown as Repository<Customer>;
    action = new GetCustomerSalesHistoryAction(repoMock);
  };

  const sql = (): string => String(querySpy.mock.calls[0][0]);

  describe('cómo se arma la consulta', () => {
    it('toma el ajuste de la vista consolidada', async () => {
      build();
      await action.execute(11793, 13);

      expect(sql()).toContain('v_sale_note_adjustments');
      expect(sql()).toContain('si.total + COALESCE(adj.total_adjustment, 0)');
    });

    it('ajusta también el costo, no solo el total', async () => {
      // Consolidar solo el total dejaría la ganancia inflada: el producto
      // devuelto seguiría contando como costo de la venta.
      build();
      await action.execute(11793, 13);

      expect(sql()).toContain('si.cost  + COALESCE(adj.cost_adjustment, 0)');
    });

    it('deriva ganancia y margen del consolidado, no los arrastra', async () => {
      build();
      await action.execute(11793, 13);

      expect(sql()).toContain('(b.total - b.cost) AS profit');
      expect(sql()).toContain('WHEN b.total > 0');
      // Arrastrar los persistidos imprimiría un porcentaje que no corresponde
      // a las cifras de al lado.
      expect(sql()).not.toContain('si.profit');
      expect(sql()).not.toContain('si.margin');
    });

    it('sigue dejando fuera las ventas anuladas', async () => {
      // Al cliente no se le vendió nada: la anulada no es una compra suya.
      build();
      await action.execute(11793, 13);

      expect(sql()).toContain('si.is_deleted = false');
    });

    it('no consulta sin company_id', async () => {
      build();
      await action.execute(11793, 13);

      expect(sql()).toContain('si.company_id = $1');
      expect(sql()).toContain('adj.company_id = si.company_id');
      expect(querySpy.mock.calls[0][1]).toEqual(['13', '11793']);
    });
  });

  describe('lo que ve el cliente', () => {
    it('la venta ajustada se lista por su consolidado', async () => {
      build([row()]);

      const result = await action.execute(11793, 13);

      expect(result.invoices[0].total).toBe(53946);
      expect(result.invoices[0].profit).toBe(30541);
      expect(result.invoices[0].total).not.toBe(27000);
    });

    it('el resumen suma los consolidados', async () => {
      // Si el resumen sumara los totales viejos, no cuadraría con las filas
      // que tiene encima.
      build([row(), row({ id: '2', ticket_number: 'PED-9', total: '10000', cost: '6000', profit: '4000' })]);

      const result = await action.execute(11793, 13);

      expect(result.summary.salesCount).toBe(2);
      expect(result.summary.totalSales).toBe(63946);
      expect(result.summary.totalCost).toBe(29405);
      expect(result.summary.totalProfit).toBe(34541);
    });

    it('un cliente sin compras devuelve el resumen en cero', async () => {
      build([]);

      const result = await action.execute(11793, 13);

      expect(result.invoices).toHaveLength(0);
      expect(result.summary.salesCount).toBe(0);
      expect(result.summary.totalSales).toBe(0);
      expect(result.summary.averageMargin).toBe(0);
    });

    it('una venta a crédito conserva su saldo autoritativo', async () => {
      // El consolidado cambia lo FACTURADO; lo que debe sale de sale_credits y
      // no puede tocarse desde aquí.
      build([
        row({
          is_credit: true,
          credit_status: 'PENDING',
          credit_balance: '20000',
          credit_paid: '33946',
          credit_total: '53946',
        }),
      ]);

      const result = await action.execute(11793, 13);

      expect(result.invoices[0].paymentType).toBe('CREDITO');
      expect(result.invoices[0].isPaid).toBe(false);
      expect(result.invoices[0].creditBalance).toBe(20000);
    });

    it('una venta que quedó en cero no produce margen infinito', async () => {
      build([row({ total: '0', cost: '0', profit: '0', margin: '0' })]);

      const result = await action.execute(11793, 13);

      expect(result.invoices[0].margin).toBe(0);
      expect(result.summary.averageMargin).toBe(0);
      expect(Number.isFinite(result.summary.averageMargin)).toBe(true);
    });
  });
});
