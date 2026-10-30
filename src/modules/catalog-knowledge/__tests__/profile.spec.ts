import {
  PROFILE_LIMITS,
  buildFamilyText,
  dot,
  isProfileEmpty,
  normalizeVector,
  sanitizeAttributes,
  sanitizeProfile,
  sanitizeRelated,
  sanitizeTags,
  textHash,
  topMatches,
} from '../internal/profile';

describe('sanitizeTags', () => {
  it('recorta, colapsa espacios y quita vacíos y repetidos (sin importar mayúsculas)', () => {
    expect(
      sanitizeTags(['  Hamburguesa  con   papas ', 'hamburguesa con papas', '', 3, 'Domicilio']),
    ).toEqual(['Hamburguesa con papas', 'Domicilio']);
  });

  it('acota el largo de cada etiqueta y la cantidad', () => {
    const many = Array.from({ length: 30 }, (_, i) => `uso ${i}`);
    expect(sanitizeTags(many)).toHaveLength(PROFILE_LIMITS.listItems);
    expect(sanitizeTags(['x'.repeat(200)])[0]).toHaveLength(PROFILE_LIMITS.tag);
  });

  it('lo que no es lista queda vacío', () => {
    expect(sanitizeTags('hamburguesa')).toEqual([]);
    expect(sanitizeTags(null)).toEqual([]);
  });
});

describe('sanitizeAttributes', () => {
  it('guarda pares nombre/valor válidos; números como texto; sin nombres repetidos', () => {
    expect(
      sanitizeAttributes([
        { name: ' Compartimentos ', value: 2 },
        { name: 'compartimentos', value: '3' },
        { name: 'Material', value: '  icopor ' },
        { name: '', value: 'x' },
        { name: 'vacío', value: '' },
        'basura',
        null,
      ]),
    ).toEqual([
      { name: 'Compartimentos', value: '2' },
      { name: 'Material', value: 'icopor' },
    ]);
  });
});

describe('sanitizeRelated', () => {
  it('acepta ids positivos con tipo conocido, sin sí mismo ni repetidos', () => {
    expect(
      sanitizeRelated(
        [
          { product_id: 12, kind: 'upgrade' },
          { product_id: '13', kind: 'complement' },
          { product_id: 12, kind: 'alternative' },
          { product_id: 5, kind: 'upgrade' },
          { product_id: -1, kind: 'upgrade' },
          { product_id: 14, kind: 'hermano' },
          { product_id: 1.5, kind: 'upgrade' },
        ],
        5,
      ),
    ).toEqual([
      { product_id: 12, kind: 'upgrade' },
      { product_id: 13, kind: 'complement' },
    ]);
  });

  it('acota la cantidad de relacionados', () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ product_id: i + 10, kind: 'complement' }));
    expect(sanitizeRelated(many, 1)).toHaveLength(PROFILE_LIMITS.related);
  });
});

describe('sanitizeProfile / isProfileEmpty', () => {
  it('sanea todo y recorta la descripción', () => {
    const profile = sanitizeProfile(
      {
        description: `  ${'a'.repeat(2000)}  `,
        uses: ['x'],
        attributes: [],
        aliases: ['y'],
        related: [],
      },
      1,
    );
    expect(profile.description).toHaveLength(PROFILE_LIMITS.description);
    expect(profile.uses).toEqual(['x']);
    expect(profile.aliases).toEqual(['y']);
  });

  it('una ficha sin datos se reconoce como vacía', () => {
    expect(isProfileEmpty(sanitizeProfile({}, 1))).toBe(true);
    expect(isProfileEmpty(sanitizeProfile({ uses: ['asados'] }, 1))).toBe(false);
  });
});

describe('buildFamilyText', () => {
  it('incluye nombre, categoría, presentaciones (sin repetir el base) y la ficha', () => {
    const text = buildFamilyText({
      name: 'Contenedor J2',
      category: 'Desechables',
      presentations: ['Contenedor J2 x 50', 'Contenedor J2', 'Contenedor J2 x 100'],
      profile: {
        description: 'Contenedor de icopor con dos compartimentos.',
        uses: ['hamburguesa con papas', 'domicilio'],
        attributes: [{ name: 'compartimentos', value: '2' }],
        aliases: ['portacomida'],
      },
    });
    expect(text).toBe(
      [
        'Producto: Contenedor J2',
        'Categoría: Desechables',
        'Presentaciones: Contenedor J2 x 100; Contenedor J2 x 50',
        'Descripción: Contenedor de icopor con dos compartimentos.',
        'Sirve para: hamburguesa con papas, domicilio',
        'Características: compartimentos: 2',
        'También lo llaman: portacomida',
      ].join('\n'),
    );
  });

  it('es determinista: el orden de las presentaciones no cambia el hash', () => {
    const a = buildFamilyText({
      name: 'P',
      category: null,
      presentations: ['b', 'a'],
      profile: null,
    });
    const b = buildFamilyText({
      name: 'P',
      category: null,
      presentations: ['a', 'b'],
      profile: null,
    });
    expect(textHash(a)).toBe(textHash(b));
    expect(textHash(a)).toHaveLength(64);
  });

  it('un cambio en la ficha cambia el hash', () => {
    const base = { name: 'P', category: null, presentations: [] };
    const before = buildFamilyText({ ...base, profile: null });
    const after = buildFamilyText({
      ...base,
      profile: { description: 'nuevo', uses: [], attributes: [], aliases: [] },
    });
    expect(textHash(before)).not.toBe(textHash(after));
  });
});

describe('vectores', () => {
  it('normaliza a norma 1 (y un vector nulo queda en ceros)', () => {
    const v = normalizeVector([3, 4]);
    expect(v[0]).toBeCloseTo(0.6);
    expect(v[1]).toBeCloseTo(0.8);
    expect(normalizeVector([0, 0])).toEqual([0, 0]);
  });

  it('dot de vectores normalizados es el coseno', () => {
    expect(dot(normalizeVector([1, 0]), normalizeVector([1, 0]))).toBeCloseTo(1);
    expect(dot(normalizeVector([1, 0]), normalizeVector([0, 1]))).toBeCloseTo(0);
  });

  it('topMatches ordena por parecido, filtra por umbral y respeta el límite', () => {
    const query = normalizeVector([1, 0]);
    const items = [
      { id: 1, vector: normalizeVector([1, 0]) },
      { id: 2, vector: normalizeVector([1, 1]) },
      { id: 3, vector: normalizeVector([0, 1]) },
      { id: 4, vector: normalizeVector([1, 0.1]) },
    ];
    const result = topMatches(query, items, 2, 0.5);
    expect(result.map((r) => r.id)).toEqual([1, 4]);
    expect(topMatches(query, items, 10, 0.5).map((r) => r.id)).toEqual([1, 4, 2]);
  });

  it('con ventana, descarta lo que queda lejos del mejor', () => {
    const query = normalizeVector([1, 0]);
    const items = [
      { id: 1, vector: normalizeVector([1, 0]) },
      { id: 2, vector: normalizeVector([1, 1]) },
      { id: 4, vector: normalizeVector([1, 0.1]) },
    ];
    expect(topMatches(query, items, 10, 0.5, 0.05).map((r) => r.id)).toEqual([1, 4]);
  });

  it('nada sobre el umbral → vacío', () => {
    expect(topMatches(normalizeVector([1, 0]), [{ id: 3, vector: [0, 1] }], 5, 0.5, 0.1)).toEqual(
      [],
    );
  });
});
