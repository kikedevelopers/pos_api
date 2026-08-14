import type { DataSource } from 'typeorm';

import { fetchCashNotes } from '../internal/sales-aggregations';

/**
 * Fan-out de las notas de ajuste en el cierre diario.
 *
 * Este test nace de un descuadre REAL en producción: el cierre del 08-may-2026
 * restaba 32.000 por una nota crédito de 16.000 (tenía 2 líneas) y sumaba
 * 38.100 por una nota débito de 12.700 (3 líneas). La causa era que
 * `SUM(cn.total)` se calculaba sobre un JOIN a `credit_note_lines`: la nota se
 * contaba una vez por cada producto que llevara. El JOIN a `sale_payments` la
 * multiplicaba otra vez por cada pago en efectivo de la factura.
 *
 * El bug vivió sin que ningún test lo viera porque todos los escenarios de
 * prueba usaban notas de UNA línea y facturas de UN pago — justo los dos casos
 * en los que el producto cartesiano no se nota.
 *
 * Se prueba sobre el SQL emitido: la alternativa (montar Postgres con una nota
 * de varias líneas) prueba lo mismo mucho más despacio, y lo que hay que
 * impedir es que alguien vuelva a poner esos JOIN.
 */
describe('fetchCashNotes · la nota no se multiplica', () => {
  let querySpy: jest.Mock;
  let dataSource: DataSource;

  beforeEach(() => {
    querySpy = jest.fn(() => Promise.resolve([{ notes_total: 0, notes_cost: 0 }]));
    dataSource = { query: querySpy } as unknown as DataSource;
  });

  const sql = async (): Promise<string> => {
    await fetchCashNotes(dataSource, '13', 'CREDIT', new Date('2026-05-08'), new Date('2026-05-09'));
    return String(querySpy.mock.calls[0][0]);
  };

  it('no une las líneas de la nota en el FROM', async () => {
    // Un JOIN a credit_note_lines multiplica `cn.total` por el número de líneas.
    const emitted = await sql();
    const fromClause = emitted.slice(emitted.indexOf('FROM'));

    expect(fromClause).not.toMatch(/JOIN\s+credit_note_lines/i);
  });

  it('agrega el costo de la nota en una subconsulta', async () => {
    // El costo sí sale de las líneas, pero sumado ANTES de unirse a la nota.
    const emitted = await sql();

    expect(emitted).toMatch(/LATERAL[\s\S]*SUM\(cnl\.unit_cost \* cnl\.quantity\)/i);
  });

  it('suma el total de la nota sin pasar por sus líneas', async () => {
    const emitted = await sql();

    expect(emitted).toMatch(/SUM\(cn\.total\)/);
  });

  it('comprueba el pago en efectivo con EXISTS, no con JOIN', async () => {
    // Con JOIN, una factura con dos pagos en efectivo cuenta su nota dos veces.
    const emitted = await sql();
    const fromClause = emitted.slice(emitted.indexOf('FROM'));

    expect(fromClause).not.toMatch(/JOIN\s+sale_payments/i);
    expect(emitted).toMatch(/EXISTS\s*\([\s\S]*sale_payments[\s\S]*payment_method = 'CASH'/i);
  });

  it('sigue filtrando por company (aislamiento entre tenants)', async () => {
    const emitted = await sql();

    expect(emitted).toContain('cn.company_id = $1');
    expect(emitted).toContain('si.company_id = $1');
    expect(emitted).toMatch(/cnl\.company_id = \$1/);
  });

  it('sigue excluyendo ventas anuladas y ventas a crédito', async () => {
    // Las de crédito van por su propia vía (fetchNewCredits); las anuladas se
    // excluyen junto con su nota, que se emite por el consolidado.
    const emitted = await sql();

    expect(emitted).toContain('si.is_deleted = false');
    expect(emitted).toMatch(/NOT EXISTS[\s\S]*sale_credits/i);
  });

  it('sigue recortando por la fecha de la VENTA', async () => {
    const emitted = await sql();

    expect(emitted).toMatch(/COALESCE\(si\.sold_at, si\.created_at\) BETWEEN \$3 AND \$4/);
  });

  it('devuelve ceros cuando no hay notas, sin romperse', async () => {
    querySpy.mockResolvedValueOnce([]);

    const result = await fetchCashNotes(
      dataSource,
      '13',
      'DEBIT',
      new Date('2026-05-08'),
      new Date('2026-05-09'),
    );

    expect(result).toEqual({ notes_total: 0, notes_cost: 0 });
  });
});
