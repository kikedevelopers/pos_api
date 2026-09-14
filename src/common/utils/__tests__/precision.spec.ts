import { computeTaxBreakdown } from '../precision';

// ---------------------------------------------------------------------------
// Desglose de IVA con precio IVA-INCLUIDO (convención colombiana).
//
// La invariante sagrada: `taxable_base + tax_amount === sale_price` al centavo,
// para que el total que se cobra nunca cambie por el desglose. Se logra
// restando la base YA redondeada del precio, no redondeando ambos por separado.
// ---------------------------------------------------------------------------

describe('computeTaxBreakdown', () => {
  it('IVA 19% sobre precio redondo', () => {
    expect(computeTaxBreakdown(11900, 19)).toEqual({ taxableBase: 10000, taxAmount: 1900 });
  });

  it('IVA 5% sobre precio redondo', () => {
    expect(computeTaxBreakdown(10500, 5)).toEqual({ taxableBase: 10000, taxAmount: 500 });
  });

  it('IVA 0%: no hay impuesto, toda la venta es base', () => {
    expect(computeTaxBreakdown(10000, 0)).toEqual({ taxableBase: 10000, taxAmount: 0 });
  });

  it('Exento (tarifa 0): igual que 0%, sin IVA', () => {
    expect(computeTaxBreakdown(3450, 0)).toEqual({ taxableBase: 3450, taxAmount: 0 });
  });

  it('tarifa negativa (defensivo) se trata como sin IVA', () => {
    expect(computeTaxBreakdown(5000, -5)).toEqual({ taxableBase: 5000, taxAmount: 0 });
  });

  it('precio 0 → base 0, IVA 0', () => {
    expect(computeTaxBreakdown(0, 19)).toEqual({ taxableBase: 0, taxAmount: 0 });
  });

  it('redondeo: base + IVA SIEMPRE reconstruyen el precio al centavo', () => {
    // Precios "feos" a 19%: 100/1.19 = 84.0336… → base 84.03, IVA 15.97.
    for (const [price, rate] of [
      [100, 19],
      [999, 19],
      [12345, 19],
      [3333, 5],
      [1, 19],
    ] as const) {
      const { taxableBase, taxAmount } = computeTaxBreakdown(price, rate);
      expect(Number((taxableBase + taxAmount).toFixed(2))).toBe(price);
    }
  });

  it('acepta strings (numeric de pg) sin perder precisión', () => {
    expect(computeTaxBreakdown('11900', '19')).toEqual({ taxableBase: 10000, taxAmount: 1900 });
  });
});
