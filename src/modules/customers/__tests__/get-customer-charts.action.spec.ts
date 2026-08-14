import type { Repository } from 'typeorm';

import type { GetIncludeOrdersInReportsAction } from '@/modules/app-settings/actions/get-include-orders-in-reports.action';
import type { Customer } from '@/modules/customers/entities/customer.entity';

import { GetCustomerChartsAction } from '../actions/get-customer-charts.action';

/**
 * La gráfica de ventas de un cliente tiene que contar lo mismo que el resto de
 * los informes: cada venta por su CONSOLIDADO (venta ± sus notas), imputada a
 * SU día.
 *
 * Antes se armaba en dos partes —ventas por un lado, notas por otro— y de ahí
 * salían tres errores que el dueño veía en pantalla:
 *
 *   1. la venta anulada se excluía pero su nota de anulación se seguía
 *      restando, y el día quedaba NEGATIVO (caso real: el cliente 11798 en
 *      −$22.400 el 18 de mayo);
 *   2. el ajuste se cargaba al día de la NOTA, moviendo dinero de un día a otro;
 *   3. el costo no se ajustaba, así que la ganancia salía inflada.
 */
describe('GetCustomerChartsAction · gráfica consolidada', () => {
  let action: GetCustomerChartsAction;
  let querySpy: jest.Mock;
  let includeOrdersSpy: jest.Mock;

  const buildAction = (rows: unknown[] = [], includeOrders = false): void => {
    querySpy = jest.fn(() => Promise.resolve(rows));
    const repoMock = {
      query: querySpy,
      manager: { findOne: jest.fn(() => Promise.resolve({ id: '7' })) },
    } as unknown as Repository<Customer>;
    includeOrdersSpy = jest.fn(() => Promise.resolve({ enabled: includeOrders }));
    action = new GetCustomerChartsAction(repoMock, {
      execute: includeOrdersSpy,
    } as unknown as GetIncludeOrdersInReportsAction);
  };

  const sql = (): string => String(querySpy.mock.calls[0][0]);
  const params = (): unknown[] => querySpy.mock.calls[0][1] as unknown[];

  const run = async (rows: unknown[] = [], includeOrders = false): Promise<unknown> => {
    buildAction(rows, includeOrders);
    return action.getSalesChart(7, 42, '2026-05-01', '2026-05-31');
  };

  describe('cómo se arma la consulta', () => {
    it('el ajuste sale de la vista consolidada, no de una suma paralela', async () => {
      // Es la fuente única de la verdad: mientras haya dos maneras de sumar lo
      // mismo, las pantallas se vuelven a separar.
      await run();

      expect(sql()).toContain('v_sale_note_adjustments');
      expect(sql()).toContain('total_adjustment');
    });

    it('la anulada entra SOLO si lleva su nota', async () => {
      // Excluirla y restar su nota igual es lo que dejaba el día en negativo.
      await run();

      expect(sql()).toContain('si.is_deleted = false OR COALESCE(adj.notes_count, 0) > 0');
    });

    it('imputa el ajuste al día de la VENTA, no al de la nota', async () => {
      // Una nota de mayo sobre una venta de marzo no puede mover dinero a mayo.
      await run();

      expect(sql()).toContain('(si.created_at AT TIME ZONE \'UTC\')::date AS day');
      expect(sql()).not.toContain('cn.created_at');
    });

    it('ajusta también el COSTO con la nota', async () => {
      // Sin esto el total baja pero el costo no, y la ganancia del día sale
      // inflada aunque el total esté bien.
      await run();

      expect(sql()).toContain('cost_adjustment');
    });

    it('respeta el flag de pedidos en vez de fijar el criterio', async () => {
      await run();

      expect(includeOrdersSpy).toHaveBeenCalledWith(42);
      expect(params()[4]).toBe(false);
      expect(sql()).toContain("si.ticket_type = 'SALE'");
    });

    it('con el flag encendido admite los pedidos', async () => {
      await run([], true);

      expect(params()[4]).toBe(true);
      expect(sql()).toContain("si.ticket_type = 'ORDER'");
    });

    it('nunca consulta sin company_id', async () => {
      // Dos companies pueden compartir customer_id: sin el filtro habría fuga
      // de datos entre negocios.
      await run();

      expect(sql()).toContain('si.company_id = $3');
      expect(sql()).toContain('adj.company_id = si.company_id');
      expect(params()[2]).toBe('42');
      expect(params()[3]).toBe('7');
    });
  });

  describe('cómo se mapean los puntos', () => {
    it('el día de la anulación total queda en cero, nunca en negativo', async () => {
      // La consulta devuelve el consolidado ya neteado: 0 vendido, 0 costo.
      const result = (await run([{ day: '2026-05-18', total_sales: '0', cost_sales: '0' }])) as {
        points: Array<{ date: string; total: number; profit: number; margin: number }>;
      };

      expect(result.points[0]).toEqual({
        date: '2026-05-18',
        total: 0,
        profit: 0,
        margin: 0,
      });
      expect(result.points[0].total).not.toBeLessThan(0);
    });

    it('un día normal calcula ganancia y margen sobre el consolidado', async () => {
      const result = (await run([
        { day: '2026-05-26', total_sales: '8400', cost_sales: '5400' },
      ])) as { points: Array<{ total: number; profit: number; margin: number }> };

      expect(result.points[0].total).toBe(8400);
      expect(result.points[0].profit).toBe(3000);
      // 3.000 / 8.400 = 35,71 %
      expect(result.points[0].margin).toBeCloseTo(35.71, 2);
    });

    it('los días sin ventas llegan en cero, no se saltan', async () => {
      // El eje X tiene que ser uniforme o la gráfica miente sobre el ritmo de
      // compra del cliente.
      const result = (await run([
        { day: '2026-05-01', total_sales: null, cost_sales: null },
        { day: '2026-05-02', total_sales: '1000', cost_sales: '600' },
      ])) as { points: Array<{ date: string; total: number; profit: number }> };

      expect(result.points).toHaveLength(2);
      expect(result.points[0]).toMatchObject({ date: '2026-05-01', total: 0, profit: 0 });
      expect(result.points[1]).toMatchObject({ date: '2026-05-02', total: 1000, profit: 400 });
    });

    it('un total en cero no produce un margen infinito', async () => {
      // Dividir por cero imprimiría "∞%" en la tarjeta del cliente.
      const result = (await run([{ day: '2026-05-18', total_sales: '0', cost_sales: '250' }])) as {
        points: Array<{ margin: number; profit: number }>;
      };

      expect(result.points[0].margin).toBe(0);
      expect(Number.isFinite(result.points[0].margin)).toBe(true);
    });
  });

  describe('validación del rango', () => {
    it('rechaza un rango invertido', async () => {
      buildAction([]);

      await expect(action.getSalesChart(7, 42, '2026-05-31', '2026-05-01')).rejects.toThrow(
        'Rango de fechas inválido',
      );
    });

    it('rechaza una fecha con formato basura', async () => {
      buildAction([]);

      await expect(action.getSalesChart(7, 42, 'ayer', '2026-05-01')).rejects.toThrow(
        'Rango de fechas inválido',
      );
    });
  });
});
