import {
  buildMigratePriceRow,
  canonicalPackagingName,
  dedupeByKey,
  hasValidPrice,
  isInvalidProduct,
  nameKey,
  packagingKey,
  sanitizeString,
  validPrices,
  type MigrateCatalogProductInput,
} from '../migrate-catalog.helpers';

/**
 * Unit de los helpers PUROS de la migración de catálogo. Cubre happy path y
 * límites (nombres basura, precios no positivos, colisión de empaque por value,
 * recálculo de profit/margin con Big.js, dedupe primer-visto-gana).
 */

describe('nameKey', () => {
  it('recorta y baja a minúsculas (espejo de lower(btrim(name)))', () => {
    expect(nameKey('  Coca Cola ')).toBe('coca cola');
    expect(nameKey('AGUA')).toBe('agua');
  });

  it('colapsa variantes de caso/espacios a la misma llave', () => {
    expect(nameKey('  Pan  ')).toBe(nameKey('pan'));
    expect(nameKey('PAN')).toBe(nameKey('pan'));
  });
});

describe('sanitizeString', () => {
  it('trim; cadena vacía o solo-espacios → null', () => {
    expect(sanitizeString('  x ')).toBe('x');
    expect(sanitizeString('   ')).toBeNull();
    expect(sanitizeString('')).toBeNull();
  });

  it('null/undefined → null', () => {
    expect(sanitizeString(null)).toBeNull();
    expect(sanitizeString(undefined)).toBeNull();
  });
});

describe('hasValidPrice / validPrices', () => {
  it('hasValidPrice: true si algún sale_price > 0', () => {
    expect(hasValidPrice([{ sale_price: 0 }, { sale_price: 5 }])).toBe(true);
  });

  it('hasValidPrice: false si vacío o todos <= 0', () => {
    expect(hasValidPrice([])).toBe(false);
    expect(hasValidPrice(undefined)).toBe(false);
    expect(hasValidPrice([{ sale_price: 0 }, { sale_price: -3 }])).toBe(false);
  });

  it('validPrices: filtra los no positivos preservando el orden', () => {
    const out = validPrices([
      { sale_price: 0 },
      { sale_price: 10, name: 'Detal' },
      { sale_price: -1 },
      { sale_price: 8, name: 'Mayor' },
    ]);
    expect(out.map((p) => p.sale_price)).toEqual([10, 8]);
    expect(out.map((p) => p.name)).toEqual(['Detal', 'Mayor']);
  });
});

describe('isInvalidProduct', () => {
  const base = (over: Partial<MigrateCatalogProductInput>): MigrateCatalogProductInput => ({
    srcId: 'a',
    name: 'Valido',
    cost: 1,
    stock: 0,
    prices: [{ sale_price: 5 }],
    ...over,
  });

  it('válido: nombre bueno + al menos un precio > 0', () => {
    expect(isInvalidProduct(base({}))).toBe(false);
  });

  it('inválido: nombre vacío / solo espacios', () => {
    expect(isInvalidProduct(base({ name: '   ' }))).toBe(true);
  });

  it('inválido: nombre basura (regex, case-insensitive, con acentos)', () => {
    expect(isInvalidProduct(base({ name: 'Producto VACIO' }))).toBe(true);
    expect(isInvalidProduct(base({ name: 'item vacío viejo' }))).toBe(true);
    expect(isInvalidProduct(base({ name: 'BORRADO' }))).toBe(true);
    expect(isInvalidProduct(base({ name: 'esto no existe ya' }))).toBe(true);
  });

  it('NO marca basura por substring parcial (límites de palabra)', () => {
    // "vaciosa" no contiene la palabra "vacio" con límite → válido.
    expect(isInvalidProduct(base({ name: 'Vaciador industrial' }))).toBe(false);
  });

  it('inválido: sin precio válido', () => {
    expect(isInvalidProduct(base({ prices: [] }))).toBe(true);
    expect(isInvalidProduct(base({ prices: [{ sale_price: 0 }] }))).toBe(true);
  });
});

describe('buildMigratePriceRow', () => {
  it('recalcula profit/margin con Big.js (no floats nativos)', () => {
    const row = buildMigratePriceRow({ sale_price: 5, iva_percentage: 19 }, 2);
    expect(row.sale_price).toBe(5);
    expect(row.profit).toBe(3); // 5 - 2
    expect(row.margin).toBe(60); // (3/5)*100
    expect(row.iva_percentage).toBe(19);
    expect(row.name).toBe('');
  });

  it('margin 0 cuando sale_price es 0 (sin división por cero)', () => {
    const row = buildMigratePriceRow({ sale_price: 0 }, 2);
    expect(row.margin).toBe(0);
    expect(row.profit).toBe(-2);
  });

  it('iva fuera de [0,100] → 0 (no viola el CHECK de la columna)', () => {
    expect(buildMigratePriceRow({ sale_price: 5, iva_percentage: 150 }, 1).iva_percentage).toBe(0);
    expect(buildMigratePriceRow({ sale_price: 5, iva_percentage: -1 }, 1).iva_percentage).toBe(0);
    expect(buildMigratePriceRow({ sale_price: 5, iva_percentage: null }, 1).iva_percentage).toBe(0);
  });

  it('preserva el name del precio (trim)', () => {
    expect(buildMigratePriceRow({ sale_price: 5, name: ' Mayor ' }, 1).name).toBe('Mayor');
  });

  it('precisión monetaria fina (evita 0.1+0.2 IEEE-754)', () => {
    const row = buildMigratePriceRow({ sale_price: 0.3, iva_percentage: 0 }, 0.1);
    expect(row.profit).toBe(0.2);
  });
});

describe('packagingKey', () => {
  it('combina nameKey y value normalizado', () => {
    expect(packagingKey(' Caja ', 6)).toBe('caja|6');
    expect(packagingKey('Caja', 6)).toBe(packagingKey(' caja ', 6));
    expect(packagingKey('Caja', 6)).not.toBe(packagingKey('Caja', 12));
  });
});

describe('canonicalPackagingName', () => {
  it('nombre libre → se usa tal cual (trim)', () => {
    const taken = new Map<string, number>();
    expect(canonicalPackagingName(' Caja ', 6, taken)).toBe('Caja');
  });

  it('nombre vacío → "EMPAQUE"', () => {
    expect(canonicalPackagingName('   ', 6, new Map())).toBe('EMPAQUE');
  });

  it('mismo nombre + MISMO value → reusa el nombre base', () => {
    const taken = new Map<string, number>([['caja', 6]]);
    expect(canonicalPackagingName('Caja', 6, taken)).toBe('Caja');
  });

  it('mismo nombre + OTRO value → variante "nombre × value"', () => {
    const taken = new Map<string, number>([['caja', 6]]);
    expect(canonicalPackagingName('Caja', 12, taken)).toBe('Caja × 12');
  });

  it('comparación de value exacta vía Big.js (6 == 6.0)', () => {
    const taken = new Map<string, number>([['caja', 6]]);
    expect(canonicalPackagingName('Caja', 6.0, taken)).toBe('Caja');
  });
});

describe('dedupeByKey', () => {
  it('primer visto gana; el resto son duplicados (orden preservado)', () => {
    const items = [
      { id: 1, k: 'a' },
      { id: 2, k: 'b' },
      { id: 3, k: 'a' },
      { id: 4, k: 'b' },
      { id: 5, k: 'c' },
    ];
    const { unique, duplicates } = dedupeByKey(items, (i) => i.k);
    expect(unique.map((i) => i.id)).toEqual([1, 2, 5]);
    expect(duplicates.map((i) => i.id)).toEqual([3, 4]);
  });

  it('lista vacía → sin únicos ni duplicados', () => {
    const { unique, duplicates } = dedupeByKey([], () => 'x');
    expect(unique).toHaveLength(0);
    expect(duplicates).toHaveLength(0);
  });
});
