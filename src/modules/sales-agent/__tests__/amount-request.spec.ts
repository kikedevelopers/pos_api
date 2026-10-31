import Big from 'big.js';

import {
  isPerGramProduct,
  productLineStem,
  resolveAmountRequest,
  type AmountCandidate,
} from '../internal/amount-request';

const candidate = (id: number, name: string, price: string, perGram = false): AmountCandidate => ({
  id,
  name,
  unit_price: new Big(price),
  per_gram: perGram,
});

// Catálogo real de Esencia & Grano (pimienta negra molida).
const PAQ_1000 = candidate(48446, 'PIMIENTA NEGRA MOLIDA PAQ. X $1 000', '1000');
const PAQ_2000 = candidate(48573, 'PIMIENTA NEGRA MOLIDA PAQ. X $2 000', '2000');
const TIRA_10 = candidate(48438, 'PIMIENTA NEGRA MOLIDA TIRA X 10 UNIDADES', '2000');
const GRAMO = candidate(48596, 'PIMIENTA NEGRA MOLIDA X GRAMO', '83', true);

describe('productLineStem', () => {
  it('quita la presentación del nombre del catálogo', () => {
    expect(productLineStem('PIMIENTA NEGRA MOLIDA PAQ. X $1 000')).toBe('PIMIENTA NEGRA MOLIDA');
    expect(productLineStem('PIMIENTA NEGRA MOLIDA X GRAMO')).toBe('PIMIENTA NEGRA MOLIDA');
    expect(productLineStem('PIMIENTA NEGRA MOLIDA TIRA X 10 UNIDADES')).toBe(
      'PIMIENTA NEGRA MOLIDA',
    );
    expect(productLineStem('COMINO MOLIDO - LIBRA')).toBe('COMINO MOLIDO');
    expect(productLineStem('UVA PASA CJ X 10K')).toBe('UVA PASA');
  });

  it('distingue variantes del producto (molida ≠ en pepa)', () => {
    expect(productLineStem('PIMIENTA NEGRA PEPA PAQ. X $2 000')).toBe('PIMIENTA NEGRA PEPA');
  });

  it('sin marca de presentación devuelve el nombre completo', () => {
    expect(productLineStem('  CABUYA PARA TAMAL ')).toBe('CABUYA PARA TAMAL');
  });
});

describe('isPerGramProduct', () => {
  it('empaque de 1 gramo o nombre terminado en GRAMO', () => {
    expect(
      isPerGramProduct({
        name: 'CLAVO X GRAMO',
        packaging_name: '1 - GRAMO',
        packaging_value: new Big(1),
      }),
    ).toBe(true);
    expect(
      isPerGramProduct({ name: 'UVA PASA GRAMO', packaging_name: null, packaging_value: null }),
    ).toBe(true);
  });

  it('un sobre de 24 g NO es por gramo', () => {
    expect(
      isPerGramProduct({
        name: 'COMINO MOLIDO X SOBRE',
        packaging_name: 'GRAMO X 24g',
        packaging_value: new Big(24),
      }),
    ).toBe(false);
  });
});

describe('resolveAmountRequest — "2000 de pimienta"', () => {
  const amount = new Big(2000);

  it('1) existe la presentación de $2.000 → 1 unidad, aunque el agente haya elegido la de $1.000', () => {
    const result = resolveAmountRequest(amount, [PAQ_1000, PAQ_2000, GRAMO], PAQ_1000.id);
    expect(result).toMatchObject({ kind: 'exact', product: PAQ_2000 });
    expect(result.kind !== 'none' && result.quantity.toString()).toBe('1');
  });

  it('1) con dos de precio exacto, la que eligió el agente; si no, el paquete', () => {
    expect(resolveAmountRequest(amount, [TIRA_10, PAQ_2000], TIRA_10.id)).toMatchObject({
      product: TIRA_10,
    });
    expect(resolveAmountRequest(amount, [TIRA_10, PAQ_2000], PAQ_1000.id)).toMatchObject({
      product: PAQ_2000,
    });
  });

  it('2) sin la de $2.000 pero con gramo → gramos sin pasarse del valor', () => {
    const result = resolveAmountRequest(amount, [PAQ_1000, GRAMO], PAQ_1000.id);
    expect(result.kind).toBe('by_gram');
    if (result.kind === 'none') return;
    expect(result.product).toBe(GRAMO);
    // 2000 / 83 = 24,09 → 24 g = $ 1.992 (nunca se pasa).
    expect(result.quantity.toString()).toBe('24');
    expect(result.total.toFixed(2)).toBe('1992.00');
  });

  it('3) sin $2.000 ni gramo, pero con $1.000 → 2 unidades de $1.000', () => {
    const result = resolveAmountRequest(amount, [PAQ_1000], PAQ_1000.id);
    expect(result.kind).toBe('units');
    if (result.kind === 'none') return;
    expect(result.product).toBe(PAQ_1000);
    expect(result.quantity.toString()).toBe('2');
    expect(result.total.toString()).toBe('2000');
  });

  it('3) prefiere la presentación más grande que divida el valor (menos unidades)', () => {
    const PAQ_500 = candidate(1, 'PIMIENTA NEGRA MOLIDA PAQ. X $500', '500');
    const result = resolveAmountRequest(new Big(2000), [PAQ_500, PAQ_1000], PAQ_500.id);
    expect(result).toMatchObject({ kind: 'units', product: PAQ_1000 });
  });

  it('4) nada cuadra (ni exacto, ni gramo, ni múltiplo) → none', () => {
    const PAQ_1500 = candidate(2, 'X PAQ. X $1 500', '1500');
    expect(resolveAmountRequest(amount, [PAQ_1500], PAQ_1500.id)).toEqual({ kind: 'none' });
    expect(resolveAmountRequest(amount, [], 1)).toEqual({ kind: 'none' });
  });

  it('un gramo más caro que el valor no sirve (0 g)', () => {
    const caro = candidate(3, 'AZAFRAN X GRAMO', '5000', true);
    expect(resolveAmountRequest(amount, [caro], caro.id)).toEqual({ kind: 'none' });
  });

  it('ignora presentaciones sin precio', () => {
    const gratis = candidate(4, 'PIMIENTA NEGRA MOLIDA PAQ. X $2 000', '0');
    expect(resolveAmountRequest(amount, [gratis], gratis.id)).toEqual({ kind: 'none' });
  });
});
