import Big from 'big.js';

import {
  buildCandidatePatterns,
  isFractionCountedTwice,
  matchCore,
  matchLine,
  MAX_LINE_OPTIONS,
  parseProduct,
  parseProductText,
  sameSize,
  tokenMatchScore,
  type MatchableProduct,
} from '../internal/sale-product-matching';

/**
 * El motor que traduce lo que dice el usuario al producto del inventario. Un
 * error aquí factura otro producto (o el tamaño equivocado), así que cada regla
 * tiene su caso: lo que debe resolver, lo que debe preguntar y lo que no debe
 * inventar.
 */

let next_id = 1;
const product = (name: string, extra: Partial<MatchableProduct> = {}): MatchableProduct => ({
  id: next_id++,
  name,
  sku_code: null,
  bar_code: null,
  packaging_name: null,
  ...extra,
});

/** El inventario real de la company 13 (familia de féculas). */
const FECULA_POOL = (): MatchableProduct[] => [
  product('FECULA DE MAIZ X LIBRA'),
  product('FECULA DE MAIZ X MEDIA LIBRA'),
  product('FECULA DE MAIZ X CUARTO DE LIBRA'),
  product('FECULA DE MAIZ X GRAMO'),
  product('FECULA DE YUCA X LIBRA'),
  product('FECULA DE YUCA X MEDIA LIBRA'),
  product('FECULA DE YUCA X CUARTO DE LIBRA'),
  product('FECULA DE YUCA X GRAMO'),
  product('ACEITE GIRASOL X LITRO', { sku_code: 'ACE-01', bar_code: '7701234567890' }),
];

const nameOf = (pool: MatchableProduct[], id: number): string =>
  pool.find((candidate) => candidate.id === id)?.name ?? '';

describe('parseProductText · núcleo y tamaño', () => {
  it.each([
    ['FECULA DE MAIZ X LIBRA', ['fecula', 'maiz'], 500, 'libra'],
    ['FECULA DE MAIZ X MEDIA LIBRA', ['fecula', 'maiz'], 250, 'media libra'],
    ['FECULA DE MAIZ X CUARTO DE LIBRA', ['fecula', 'maiz'], 125, 'cuarto libra'],
    ['FECULA DE MAIZ X GRAMO', ['fecula', 'maiz'], 1, 'gramo'],
    ['Fécula de maíz por libra', ['fecula', 'maiz'], 500, 'libra'],
    ['azucar 500g', ['azucar'], 500, '500 gramo'],
    ['ARROZ X 1/2 LIBRA', ['arroz'], 250, 'media libra'],
    ['panela tres cuartos de libra', ['panela'], 375, 'tres cuartos libra'],
    ['sal 1,5 kg', ['sal'], 1500, '1.5 kilo'],
    ['arroz por arroba', ['arroz'], 12500, 'arroba'],
  ])('"%s" → núcleo %j, %d g', (text, core, grams, label) => {
    const parsed = parseProductText(text);
    expect(parsed.core).toEqual(core);
    expect(parsed.size?.dimension).toBe('weight');
    expect(parsed.size?.base_amount).toBe(grams);
    expect(parsed.size?.label).toBe(label);
    expect(parsed.size?.fractional).toBe(/media|cuarto/.test(label));
  });

  it('volumen: litros y mililitros en la misma unidad base', () => {
    expect(parseProductText('ACEITE X LITRO').size).toMatchObject({
      dimension: 'volume',
      base_amount: 1000,
    });
    expect(parseProductText('gaseosa 400ml').size).toMatchObject({
      dimension: 'volume',
      base_amount: 400,
    });
    expect(parseProductText('leche 1 l').size).toMatchObject({
      dimension: 'volume',
      base_amount: 1000,
    });
  });

  it('empaques: van aparte de la medida (caja ≠ paca)', () => {
    expect(parseProductText('AGUA X CAJA')).toMatchObject({ pack: 'caja', size: null });
    expect(parseProductText('agua por pacas').pack).toBe('paca');
  });

  it('medida Y empaque a la vez: "aceite 3 litros caja" es la caja de 3 litros', () => {
    expect(parseProductText('aceite 3 litros caja')).toMatchObject({
      core: ['aceite'],
      pack: 'caja',
      size: { dimension: 'volume', base_amount: 3000 },
    });
    expect(parseProductText('paca de gaseosa 1.5 litros')).toMatchObject({
      core: ['gaseosa'],
      pack: 'paca',
      size: { base_amount: 1500 },
    });
  });

  it('sin tamaño: solo núcleo, sin conectores ni letras sueltas', () => {
    expect(parseProductText('Aceite de girasol x')).toEqual({
      core: ['aceite', 'girasol'],
      size: null,
      pack: null,
    });
  });

  it('una "l" o "g" sueltas no son unidad (no confunde letras con litros)', () => {
    expect(parseProductText('jabon l').size).toBeNull();
  });

  it('un "media" suelto no exige que el producto diga "media"', () => {
    expect(parseProductText('fecula media').core).toEqual(['fecula']);
  });

  it('texto vacío o solo conectores', () => {
    expect(parseProductText('')).toEqual({ core: [], size: null, pack: null });
    expect(parseProductText('de la por x')).toEqual({ core: [], size: null, pack: null });
  });

  it('el tamaño de respaldo sale del empaque cuando el nombre no lo trae', () => {
    const parsed = parseProduct(product('FECULA DE MAIZ', { packaging_name: 'MEDIA LIBRA' }));
    expect(parsed.size?.base_amount).toBe(250);
  });

  it('sameSize compara magnitud o empaque', () => {
    const libra = parseProductText('x libra').size;
    const quinientos = parseProductText('500 gr').size;
    const kilo = parseProductText('kilo').size;
    expect(libra && quinientos && sameSize(libra, quinientos)).toBe(true);
    expect(libra && kilo && sameSize(libra, kilo)).toBe(false);
  });
});

describe('tokenMatchScore / matchCore', () => {
  it('igual y plural valen 1; abreviatura 0,8; un error de tipeo 0,7', () => {
    expect(tokenMatchScore('fecula', 'fecula')).toBe(1);
    expect(tokenMatchScore('libras', 'libra')).toBe(1);
    expect(tokenMatchScore('limones', 'limon')).toBe(1);
    expect(tokenMatchScore('choco', 'chocolate')).toBe(0.8);
    expect(tokenMatchScore('fecla', 'fecula')).toBe(0.7);
  });

  it('no inventa coincidencias: palabras cortas o distintas valen 0', () => {
    expect(tokenMatchScore('sal', 'salsa')).toBe(0);
    expect(tokenMatchScore('maiz', 'yuca')).toBe(0);
    expect(tokenMatchScore('500', '250')).toBe(0);
  });

  it('cobertura, calidad y palabras sobrantes', () => {
    expect(matchCore(['fecula', 'maiz'], ['fecula', 'maiz'])).toEqual({
      coverage: 1,
      quality: 1,
      extra: 0,
    });
    expect(matchCore(['fecula', 'maiz'], ['fecula', 'yuca'])).toEqual({
      coverage: 0.5,
      quality: 1,
      extra: 1,
    });
    expect(matchCore([], ['fecula'])).toEqual({ coverage: 0, quality: 0, extra: 1 });
  });
});

describe('matchLine · resolver una línea del pedido', () => {
  it('"Fécula de maíz por libra" → FECULA DE MAIZ X LIBRA (no la media ni el cuarto)', () => {
    const pool = FECULA_POOL();
    const match = matchLine(['Fécula de maíz por libra'], pool, new Big(2));
    expect(match.status).toBe('resolved');
    expect(match.status === 'resolved' && match.product.name).toBe('FECULA DE MAIZ X LIBRA');
  });

  it('"fecula de maiz x media" no basta: "media" sin unidad no es tamaño → pregunta', () => {
    const match = matchLine(['fecula de maiz x media'], FECULA_POOL(), new Big(1));
    expect(match.status).toBe('ambiguous');
  });

  it('"Maizena por libra" se resuelve con la alternativa genérica que propone el modelo', () => {
    const pool = FECULA_POOL();
    const match = matchLine(['Maizena por libra', 'fécula de maíz por libra'], pool, new Big(1));
    expect(match.status === 'resolved' && match.product.name).toBe('FECULA DE MAIZ X LIBRA');
  });

  it('el tamaño de lo que dijo el usuario (query) manda sobre el de las alternativas', () => {
    const pool = FECULA_POOL();
    const match = matchLine(
      ['maizena por media libra', 'fécula de maíz por libra', 'fécula de maíz'],
      pool,
      new Big(4),
    );
    expect(match.status === 'resolved' && match.product.name).toBe('FECULA DE MAIZ X MEDIA LIBRA');
  });

  it('una alternativa genérica no le quita la marca exacta al nombre que sí existe', () => {
    const pool = [product('ARROZ DIANA X LIBRA'), product('ARROZ ROA X LIBRA')];
    const match = matchLine(['arroz diana por libra', 'arroz'], pool, new Big(1));
    expect(match.status === 'resolved' && match.product.name).toBe('ARROZ DIANA X LIBRA');
  });

  it('"Maizena" sola, sin alternativa, NO se adivina', () => {
    const match = matchLine(['Maizena por libra'], FECULA_POOL(), new Big(1));
    expect(match).toEqual({ status: 'not_found', similar: [] });
  });

  it('tolera mayúsculas y plurales', () => {
    const match = matchLine(['FECULAS DE MAIZ POR LIBRAS'], FECULA_POOL(), new Big(1));
    expect(match.status === 'resolved' && match.product.name).toBe('FECULA DE MAIZ X LIBRA');
  });

  it('con un error de tipeo ENCUENTRA el producto pero pregunta ("¿quisiste decir…?")', () => {
    const match = matchLine(['FECLA DE MAIZ POR LIBRA'], FECULA_POOL(), new Big(1));
    expect(match).toEqual({
      status: 'ambiguous',
      options: [expect.objectContaining({ name: 'FECULA DE MAIZ X LIBRA' })],
    });
  });

  describe('nunca elige en silencio (casos de la revisión de seguridad)', () => {
    const names = (match: ReturnType<typeof matchLine>): string[] =>
      match.status === 'ambiguous' ? match.options.map((option) => option.name) : [];

    it('dos marcas del mismo tamaño → pregunta', () => {
      const pool = [product('GASEOSA COCA COLA 1.5L'), product('GASEOSA POSTOBON 1.5 LT')];
      expect(names(matchLine(['gaseosa 1.5 litros'], pool, new Big(1)))).toHaveLength(2);
    });

    it('dos presentaciones con palabras de más → pregunta', () => {
      const pool = [product('ACEITE GIRASOL 1L'), product('ACEITE OLIVA EXTRA VIRGEN 500ML')];
      expect(matchLine(['aceite'], pool, new Big(1)).status).toBe('ambiguous');
      const latas = [product('CERVEZA AGUILA LATA'), product('CERVEZA AGUILA LIGHT LATA')];
      expect(matchLine(['cerveza aguila'], latas, new Big(1)).status).toBe('ambiguous');
    });

    it('sin tamaño pedido y la familia trae tamaños distintos → pregunta el tamaño', () => {
      const pool = [product('FECULA X LIBRA'), product('FECULA MAIZENA X KILO')];
      expect(matchLine(['fecula'], pool, new Big(1)).status).toBe('ambiguous');
    });

    it.each([
      ['papa', 'PAPAYA X LIBRA'],
      ['pollo', 'POLVO PARA HORNEAR'],
      ['leche', 'LECHERA NESTLE'],
    ])('"%s" con un único parecido aproximado (%s) → pregunta, no lo elige', (query, name) => {
      expect(matchLine([query], [product(name)], new Big(1))).toEqual({
        status: 'ambiguous',
        options: [expect.objectContaining({ name })],
      });
    });

    it('"aceite 3 litros caja" → la CAJA, nunca la botella', () => {
      const pool = [product('ACEITE 3 LITROS'), product('ACEITE 3 LITROS CAJA X 12')];
      const match = matchLine(['aceite 3 litros caja'], pool, new Big(1));
      expect(match.status === 'resolved' && match.product.name).toBe('ACEITE 3 LITROS CAJA X 12');
    });

    it('"aceite 3 litros" sin decir caja → la botella (nombre exacto), no la caja', () => {
      const pool = [product('ACEITE 3 LITROS'), product('ACEITE 3 LITROS CAJA X 12')];
      const match = matchLine(['aceite 3 litros'], pool, new Big(1));
      expect(match.status === 'resolved' && match.product.name).toBe('ACEITE 3 LITROS');
    });

    it('"paca de gaseosa 1.5 litros" → la paca', () => {
      const pool = [product('GASEOSA 1.5 LITROS'), product('GASEOSA 1.5 LITROS X PACA')];
      const match = matchLine(['paca de gaseosa 1.5 litros'], pool, new Big(1));
      expect(match.status === 'resolved' && match.product.name).toBe('GASEOSA 1.5 LITROS X PACA');
    });

    it('caja pedida que no existe → no ofrece equivalencia contra la botella', () => {
      const pool = [product('ACEITE 3 LITROS')];
      const match = matchLine(['aceite 3 litros caja'], pool, new Big(1));
      expect(match.status).toBe('size_unavailable');
      expect(
        match.status === 'size_unavailable' && match.alternatives[0].equivalent_quantity,
      ).toBeNull();
    });
  });

  it('el tamaño se compara por magnitud: "500 gr de fécula de maíz" = la libra', () => {
    const match = matchLine(['fecula de maiz 500 gr'], FECULA_POOL(), new Big(1));
    expect(match.status === 'resolved' && match.product.name).toBe('FECULA DE MAIZ X LIBRA');
  });

  it('sin tamaño y con varios tamaños en la familia → pregunta cuál (no elige uno)', () => {
    const match = matchLine(['fecula de maiz'], FECULA_POOL(), new Big(1));
    expect(match.status).toBe('ambiguous');
    expect(match.status === 'ambiguous' && match.options.map((p) => p.name)).toEqual([
      'FECULA DE MAIZ X CUARTO DE LIBRA',
      'FECULA DE MAIZ X GRAMO',
      'FECULA DE MAIZ X LIBRA',
      'FECULA DE MAIZ X MEDIA LIBRA',
    ]);
  });

  it('"fécula por libra" (sin decir maíz o yuca) → ambiguo entre las dos libras', () => {
    const match = matchLine(['fecula por libra'], FECULA_POOL(), new Big(1));
    expect(match.status === 'ambiguous' && match.options.map((p) => p.name)).toEqual([
      'FECULA DE MAIZ X LIBRA',
      'FECULA DE YUCA X LIBRA',
    ]);
  });

  it('un único producto con ese núcleo se resuelve aunque no se diga el tamaño', () => {
    const match = matchLine(['aceite de girasol'], FECULA_POOL(), new Big(1));
    expect(match.status === 'resolved' && match.product.name).toBe('ACEITE GIRASOL X LITRO');
  });

  it('prefiere el nombre exacto sobre uno con palabras de más', () => {
    const pool = [product('ARROZ X LIBRA'), product('ARROZ INTEGRAL X LIBRA')];
    const match = matchLine(['arroz por libra'], pool, new Big(1));
    expect(match.status === 'resolved' && match.product.name).toBe('ARROZ X LIBRA');
  });

  it('código SKU o de barras exacto resuelve directo', () => {
    const pool = FECULA_POOL();
    expect(matchLine(['ace-01'], pool, null)).toMatchObject({ status: 'resolved', via: 'code' });
    expect(matchLine(['7701234567890'], pool, null)).toMatchObject({
      status: 'resolved',
      via: 'code',
    });
  });

  describe('tamaño inexistente → sugiere los disponibles con equivalencia', () => {
    const POOL_SIN_LIBRA = (): MatchableProduct[] => [
      product('FECULA DE MAIZ X MEDIA LIBRA'),
      product('FECULA DE MAIZ X CUARTO DE LIBRA'),
      product('FECULA DE MAIZ X GRAMO'),
      product('FECULA DE MAIZ X KILO'),
      product('FECULA DE YUCA X LIBRA'),
    ];

    it('2 libras pedidas, sin la libra: primero los MENORES con su cantidad equivalente', () => {
      const match = matchLine(['fecula de maiz por libra'], POOL_SIN_LIBRA(), new Big(2));
      expect(match.status).toBe('size_unavailable');
      if (match.status !== 'size_unavailable') {
        return;
      }
      expect(match.requested_size).toBe('libra');
      expect(match.alternatives.map((alt) => [alt.product.name, alt.equivalent_quantity])).toEqual([
        ['FECULA DE MAIZ X MEDIA LIBRA', 4],
        ['FECULA DE MAIZ X CUARTO DE LIBRA', 8],
        ['FECULA DE MAIZ X GRAMO', 1000],
        ['FECULA DE MAIZ X KILO', 1],
      ]);
    });

    it('nunca ofrece otro producto de la familia equivocada (yuca ≠ maíz)', () => {
      const match = matchLine(['fecula de maiz por libra'], POOL_SIN_LIBRA(), new Big(1));
      expect(
        match.status === 'size_unavailable' && match.alternatives.map((alt) => alt.product.name),
      ).not.toContain('FECULA DE YUCA X LIBRA');
    });

    it('sin cantidad válida no calcula equivalencia (pero sí ofrece los tamaños)', () => {
      const match = matchLine(['fecula de maiz por libra'], POOL_SIN_LIBRA(), null);
      expect(
        match.status === 'size_unavailable' &&
          match.alternatives.every((alt) => alt.equivalent_quantity === null),
      ).toBe(true);
    });

    it('equivalencias con decimales se redondean a 4 (escala de la cantidad)', () => {
      const pool = [product('QUESO X LIBRA')];
      const match = matchLine(['queso por 300 gr'], pool, new Big(1));
      expect(match.status === 'size_unavailable' && match.alternatives[0].equivalent_quantity).toBe(
        0.6,
      );
    });

    it('empaque distinto (paca vs caja): ofrece la caja sin inventar equivalencia', () => {
      const pool = [product('AGUA CRISTAL X CAJA'), product('AGUA CRISTAL X UNIDAD')];
      const match = matchLine(['agua cristal por paca'], pool, new Big(1));
      expect(match.status).toBe('size_unavailable');
      expect(
        match.status === 'size_unavailable' &&
          match.alternatives.map((alt) => alt.equivalent_quantity),
      ).toEqual([null, null]);
    });
  });

  it('no encontrado: devuelve similares (mitad del núcleo) para que Place los muestre', () => {
    const match = matchLine(['fecula de arroz por libra'], FECULA_POOL(), new Big(1));
    expect(match.status).toBe('not_found');
    expect(match.status === 'not_found' && match.similar.length).toBeGreaterThan(0);
  });

  it('nada parecido → no_found vacío (no inventa)', () => {
    expect(matchLine(['tornillo'], FECULA_POOL(), new Big(1))).toEqual({
      status: 'not_found',
      similar: [],
    });
  });

  it('consulta vacía o solo conectores → no encontrado', () => {
    expect(matchLine(['  ', ''], FECULA_POOL(), null)).toEqual({
      status: 'not_found',
      similar: [],
    });
    expect(matchLine(['de la x'], FECULA_POOL(), null)).toEqual({
      status: 'not_found',
      similar: [],
    });
  });

  it('las opciones vienen acotadas', () => {
    const pool = Array.from({ length: 20 }, (_, index) =>
      product(`GALLETA SABOR ${index} X UNIDAD`),
    );
    const match = matchLine(['galleta'], pool, new Big(1));
    expect(match.status === 'ambiguous' && match.options.length).toBe(MAX_LINE_OPTIONS);
  });

  it('dos productos con el mismo código → ambiguo (nunca elige a ciegas)', () => {
    const pool = [product('A', { sku_code: 'X1' }), product('B', { bar_code: 'x1' })];
    expect(matchLine(['X1'], pool, null).status).toBe('ambiguous');
  });

  it('usa el id real del pool', () => {
    const pool = FECULA_POOL();
    const match = matchLine(['fecula de yuca por media libra'], pool, new Big(1));
    expect(match.status === 'resolved' && nameOf(pool, match.product.id)).toBe(
      'FECULA DE YUCA X MEDIA LIBRA',
    );
  });
});

describe('isFractionCountedTwice', () => {
  it('"media libra" con cantidad 0.5 → doble conteo (sería un cuarto de libra)', () => {
    expect(isFractionCountedTwice(['fécula de yuca por media libra'], new Big('0.5'))).toBe(true);
    expect(isFractionCountedTwice(['FECULA DE MAIZ X CUARTO DE LIBRA'], new Big('1.5'))).toBe(true);
  });

  it('cantidades enteras de un tamaño fraccionario son normales', () => {
    expect(isFractionCountedTwice(['fécula por media libra'], new Big(1))).toBe(false);
    expect(isFractionCountedTwice(['fécula por media libra'], new Big(4))).toBe(false);
  });

  it('fracción en la cantidad con un tamaño entero es normal (0.5 de la libra)', () => {
    expect(isFractionCountedTwice(['fécula por libra'], new Big('0.5'))).toBe(false);
    expect(isFractionCountedTwice(['queso por 250 gr'], new Big('1.5'))).toBe(false);
    expect(isFractionCountedTwice(['arroz'], new Big('0.5'))).toBe(false);
  });
});

describe('buildCandidatePatterns', () => {
  it('raíces de 4 letras del núcleo de todas las consultas, sin repetir', () => {
    expect(
      buildCandidatePatterns(['Fécula de maíz por libra', 'Maizena x libra', 'fecula']),
    ).toEqual(['%fecu%', '%maiz%']);
  });

  it('escapa comodines de LIKE y omite palabras muy cortas', () => {
    expect(buildCandidatePatterns(['50%_off de sal'])).toEqual(['%50%', '%off%', '%sal%']);
    expect(buildCandidatePatterns(['ab'])).toEqual([]);
  });
});
