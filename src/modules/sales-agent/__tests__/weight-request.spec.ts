import Big from 'big.js';

import {
  presentationGrams,
  readWeightRequested,
  resolveWeightRequest,
  weightLabel,
  type WeightCandidate,
} from '../internal/weight-request';

const product = (name: string, packaging: string | null = null, value: string | null = null) => ({
  name,
  packaging_name: packaging,
  packaging_value: value === null ? null : new Big(value),
});

const candidate = (
  id: number,
  name: string,
  price: string,
  grams: number | null,
  perGram = false,
): WeightCandidate => ({
  id,
  name,
  unit_price: new Big(price),
  per_gram: perGram,
  grams: grams === null ? null : new Big(grams),
});

// Catálogo real de Esencia & Grano (maní tostado con sal).
const LIBRA = candidate(45924, 'MANI TOSTADO LIBRA CON SAL', '8600', 500);
const MEDIA = candidate(47046, 'MANI TOSTADO 1/2 LIBRA CON SAL', '4300', 250);
const GRAMO = candidate(47047, 'MANI TOSTADO CON SAL GRAMO', '18', 1, true);
const MANI = [LIBRA, MEDIA, GRAMO];

const request = (raw: unknown) => {
  const parsed = readWeightRequested(raw);
  if (!parsed) throw new Error('pedido inválido');
  return parsed;
};

describe('readWeightRequested', () => {
  it('convierte la medida a gramos (medidas de Colombia)', () => {
    expect(request({ quantity: 1, unit: 'arroba' }).grams.toString()).toBe('12500');
    expect(request({ quantity: 2, unit: 'kilo' }).grams.toString()).toBe('2000');
    expect(request({ quantity: '3', unit: 'libra' }).grams.toString()).toBe('1500');
    expect(request({ quantity: 1, unit: 'media_libra' }).grams.toString()).toBe('250');
    expect(request({ quantity: 1, unit: 'cuarto' }).grams.toString()).toBe('125');
    expect(request({ quantity: 300, unit: 'gramo' }).grams.toString()).toBe('300');
  });

  it('acepta fracciones que dan gramos enteros ("media arroba", "1,5 kilos")', () => {
    expect(request({ quantity: 0.5, unit: 'arroba' }).grams.toString()).toBe('6250');
    expect(request({ quantity: '1,5', unit: 'KILO' }).grams.toString()).toBe('1500');
  });

  it.each([
    [null],
    ['1 arroba'],
    [{ quantity: 1 }],
    [{ quantity: 1, unit: 'tonelada' }],
    [{ quantity: 0, unit: 'libra' }],
    [{ quantity: -2, unit: 'libra' }],
    [{ quantity: 'dos', unit: 'libra' }],
    [{ quantity: 0.5, unit: 'gramo' }],
    [{ quantity: 1000, unit: 'arroba' }],
  ])('rechaza %j', (raw) => {
    expect(readWeightRequested(raw)).toBeNull();
  });
});

describe('weightLabel', () => {
  it('singular, plural y decimales con coma', () => {
    expect(weightLabel(new Big(1), 'arroba')).toBe('1 arroba');
    expect(weightLabel(new Big(25), 'libra')).toBe('25 libras');
    expect(weightLabel(new Big(1.5), 'kilo')).toBe('1,5 kilos');
    expect(weightLabel(new Big(2), 'media_libra')).toBe('2 medias libras');
  });
});

describe('presentationGrams', () => {
  it('lee el empaque en gramos (la libra del catálogo es "GRAMO" × 500)', () => {
    expect(presentationGrams(product('MANI TOSTADO LIBRA CON SAL', 'GRAMO', '500'))).toEqual(
      new Big(500),
    );
    expect(presentationGrams(product('UVA PASA 1/2 LIBRA', 'GRAMOS', '250'))).toEqual(new Big(250));
  });

  it('empaques en kilos, libras o arrobas', () => {
    expect(presentationGrams(product('ARROZ', 'KILO', '2'))?.toString()).toBe('2000');
    expect(presentationGrams(product('ARROZ', 'LIBRAS', '5'))?.toString()).toBe('2500');
    expect(presentationGrams(product('ARROZ', 'ARROBA', '1'))?.toString()).toBe('12500');
  });

  it('el producto por gramo pesa 1 g', () => {
    expect(presentationGrams(product('MANI TOSTADO CON SAL GRAMO', 'GRAMO X 1', '1'))).toEqual(
      new Big(1),
    );
  });

  it.each([
    ['MANI TOSTADO 1/2 LIBRA CON SAL', '250'],
    ['COMBINADO UVA PASA + MANI X MEDIA LIBRA', '250'],
    ['COMBINADO UVA PASA + MANI X CUARTO DE LIBRA', '125'],
    ['MANI X 1/4', '125'],
    ['UVA PASA LIBRA', '500'],
    ['FRIJOL 2 LIBRAS', '1000'],
    ['ARROZ X ARROBA', '12500'],
    ['ARROZ MEDIA ARROBA', '6250'],
    ['AZUCAR KILO', '1000'],
    ['AZUCAR MEDIO KILO', '500'],
    ['UVA PASA CJ X 10K', '10000'],
    ['CAFE 2,5 KG', '2500'],
    ['CANELA 50 GR', '50'],
    ['Maní 1/2 libra', '250'],
  ])('sin empaque de peso, lee la medida del nombre: %s', (name, grams) => {
    expect(presentationGrams(product(name, 'CAJA × 12', '12'))?.toString()).toBe(grams);
  });

  it('sin medida de peso → null', () => {
    expect(presentationGrams(product('PIMIENTA NEGRA MOLIDA PAQ. X $1 000'))).toBeNull();
    expect(presentationGrams(product('ACEITE 1L', 'CAJA × 12', '12'))).toBeNull();
  });
});

describe('resolveWeightRequest', () => {
  it('1 @ de maní sin presentación de arroba → equivalencia: 25 libras (para OFRECER)', () => {
    const result = resolveWeightRequest(request({ quantity: 1, unit: 'arroba' }), MANI, 47046);
    expect(result).toEqual(
      expect.objectContaining({ kind: 'units', product: LIBRA, same_measure: false }),
    );
    expect(result.kind !== 'none' && result.quantity.toString()).toBe('25');
    expect(result.kind !== 'none' && result.total.toString()).toBe('215000');
  });

  it('con presentación de arroba → esa, 1 unidad (se anota)', () => {
    const ARROBA = candidate(9, 'MANI TOSTADO X ARROBA', '200000', 12500);
    const result = resolveWeightRequest(
      request({ quantity: 1, unit: 'arroba' }),
      [...MANI, ARROBA],
      45924,
    );
    expect(result).toEqual(
      expect.objectContaining({ kind: 'exact', product: ARROBA, same_measure: true }),
    );
    expect(result.kind !== 'none' && result.quantity.toString()).toBe('1');
  });

  it('3 libras → 3 × libra, es la misma medida (se anota)', () => {
    const result = resolveWeightRequest(request({ quantity: 3, unit: 'libra' }), MANI, 47047);
    expect(result).toEqual(
      expect.objectContaining({ kind: 'units', product: LIBRA, same_measure: true }),
    );
    expect(result.kind !== 'none' && result.quantity.toString()).toBe('3');
  });

  it('media libra → la presentación de media libra (exacta)', () => {
    const result = resolveWeightRequest(request({ quantity: 1, unit: 'media_libra' }), MANI, 45924);
    expect(result).toEqual(expect.objectContaining({ kind: 'exact', product: MEDIA }));
  });

  it('1 kilo → 2 libras (equivalencia: se ofrece)', () => {
    const result = resolveWeightRequest(request({ quantity: 1, unit: 'kilo' }), MANI, 45924);
    expect(result).toEqual(
      expect.objectContaining({ kind: 'units', product: LIBRA, same_measure: false }),
    );
    expect(result.kind !== 'none' && result.quantity.toString()).toBe('2');
  });

  it('3 cuartos sin presentación que los sume exacto → por gramos', () => {
    const result = resolveWeightRequest(request({ quantity: 3, unit: 'cuarto' }), MANI, 45924);
    expect(result).toEqual(
      expect.objectContaining({ kind: 'by_gram', product: GRAMO, same_measure: false }),
    );
    expect(result.kind !== 'none' && result.quantity.toString()).toBe('375');
    expect(result.kind !== 'none' && result.total.toString()).toBe('6750');
  });

  it('pidió gramos y solo hay por gramo → misma medida', () => {
    const result = resolveWeightRequest(request({ quantity: 300, unit: 'gramo' }), [GRAMO], 47047);
    expect(result).toEqual(
      expect.objectContaining({ kind: 'by_gram', product: GRAMO, same_measure: true }),
    );
  });

  it('ignora presentaciones sin peso o sin precio', () => {
    const PAQUETE = candidate(1, 'MANI PAQ. X $1 000', '1000', null);
    const SIN_PRECIO = candidate(2, 'MANI LIBRA', '0', 500);
    const result = resolveWeightRequest(
      request({ quantity: 1, unit: 'libra' }),
      [PAQUETE, SIN_PRECIO],
      1,
    );
    expect(result).toEqual({ kind: 'none' });
  });

  it('nada cuadra → none', () => {
    const result = resolveWeightRequest(request({ quantity: 1, unit: 'cuarto' }), [LIBRA], 45924);
    expect(result).toEqual({ kind: 'none' });
  });

  it('empate exacto: prefiere la presentación que mandó el agente', () => {
    const OTRA_LIBRA = candidate(27462, 'MANI TOSTADO LIBRA CON SAL', '8600', 500);
    const result = resolveWeightRequest(
      request({ quantity: 1, unit: 'libra' }),
      [LIBRA, OTRA_LIBRA],
      27462,
    );
    expect(result).toEqual(expect.objectContaining({ kind: 'exact', product: OTRA_LIBRA }));
  });
});
