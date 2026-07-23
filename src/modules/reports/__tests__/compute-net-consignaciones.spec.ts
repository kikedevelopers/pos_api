import {
  computeNetConsignaciones,
  type ConsigDetalleRow,
  type ConsigRow,
  type TransferNoteRow,
} from '../internal/sales-aggregations';

/**
 * Tests de `computeNetConsignaciones`: combina consignaciones brutas con el
 * ajuste por notas (NC/ND) prorrateado por banco. El `adj` llega con signo
 * (NC negativo, ND positivo).
 */
describe('computeNetConsignaciones', () => {
  const gross: ConsigRow = { consig_total: 100000, consig_cost: 60000 };
  const detalle: ConsigDetalleRow[] = [
    { bank_name: 'NEQUI', amount: 70000 },
    { bank_name: 'BANCOLOMBIA', amount: 30000 },
  ];

  it('sin notas: devuelve el bruto intacto', () => {
    const res = computeNetConsignaciones(gross, detalle, []);
    expect(res.totals).toEqual({ consig_total: 100000, consig_cost: 60000 });
    expect(res.detalle).toEqual([
      { bank_name: 'NEQUI', amount: 70000 },
      { bank_name: 'BANCOLOMBIA', amount: 30000 },
    ]);
  });

  it('NC resta del total, del costo y del banco correspondiente', () => {
    const notes: TransferNoteRow[] = [{ bank_name: 'NEQUI', adj: -20000, cost_adj: -12000 }];
    const res = computeNetConsignaciones(gross, detalle, notes);
    expect(res.totals.consig_total).toBe(80000); // 100.000 − 20.000
    expect(res.totals.consig_cost).toBe(48000); // 60.000 − 12.000
    expect(res.detalle).toEqual([
      { bank_name: 'NEQUI', amount: 50000 }, // 70.000 − 20.000
      { bank_name: 'BANCOLOMBIA', amount: 30000 },
    ]);
  });

  it('ND suma al total, al costo y al banco', () => {
    const notes: TransferNoteRow[] = [{ bank_name: 'BANCOLOMBIA', adj: 5000, cost_adj: 3000 }];
    const res = computeNetConsignaciones(gross, detalle, notes);
    expect(res.totals.consig_total).toBe(105000);
    expect(res.totals.consig_cost).toBe(63000);
    // BANCOLOMBIA 35.000 pasa a estar por encima de NEQUI en el orden.
    expect(res.detalle).toEqual([
      { bank_name: 'NEQUI', amount: 70000 },
      { bank_name: 'BANCOLOMBIA', amount: 35000 },
    ]);
  });

  it('nota prorrateada entre dos bancos (llega ya repartida)', () => {
    const notes: TransferNoteRow[] = [
      { bank_name: 'NEQUI', adj: -7000, cost_adj: -4200 },
      { bank_name: 'BANCOLOMBIA', adj: -3000, cost_adj: -1800 },
    ];
    const res = computeNetConsignaciones(gross, detalle, notes);
    expect(res.totals.consig_total).toBe(90000); // −10.000
    expect(res.totals.consig_cost).toBe(54000); // −6.000
    expect(res.detalle).toEqual([
      { bank_name: 'NEQUI', amount: 63000 },
      { bank_name: 'BANCOLOMBIA', amount: 27000 },
    ]);
  });

  it('anulación total de un banco: se omite del detalle (queda en ~0)', () => {
    const notes: TransferNoteRow[] = [{ bank_name: 'BANCOLOMBIA', adj: -30000, cost_adj: -18000 }];
    const res = computeNetConsignaciones(gross, detalle, notes);
    expect(res.totals.consig_total).toBe(70000);
    expect(res.detalle).toEqual([{ bank_name: 'NEQUI', amount: 70000 }]);
  });

  it('nota sobre un banco que no estaba en el bruto lo agrega', () => {
    // Caso defensivo: no debería pasar (el banco de la nota viene del bruto),
    // pero si pasara, se agrega sin romper.
    const notes: TransferNoteRow[] = [{ bank_name: 'DAVIPLATA', adj: 5000, cost_adj: 3000 }];
    const res = computeNetConsignaciones(gross, detalle, notes);
    expect(res.totals.consig_total).toBe(105000);
    expect(res.detalle.find((d) => d.bank_name === 'DAVIPLATA')?.amount).toBe(5000);
  });
})
