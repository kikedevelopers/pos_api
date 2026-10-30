import { buildSuggestionPrompt, parseProfileSuggestion } from '../internal/suggestion';

describe('buildSuggestionPrompt', () => {
  it('incluye el producto, la categoría, las presentaciones y pide JSON', () => {
    const prompt = buildSuggestionPrompt({
      name: 'CONTENEDOR J2',
      category: 'Desechables',
      presentations: ['CONTENEDOR J2 X 50'],
      business: 'Empaques Ya',
    });
    expect(prompt).toContain('Producto: CONTENEDOR J2');
    expect(prompt).toContain('Categoría: Desechables');
    expect(prompt).toContain('Presentaciones: CONTENEDOR J2 X 50');
    expect(prompt).toContain('Negocio: Empaques Ya');
    expect(prompt).toMatch(/Devuelve SOLO un JSON/);
    expect(prompt).toMatch(/Nunca inventes medidas/);
  });

  it('omite lo que no hay (sin categoría, presentaciones ni negocio)', () => {
    const prompt = buildSuggestionPrompt({
      name: 'X',
      category: null,
      presentations: [],
      business: null,
    });
    expect(prompt).not.toContain('Categoría:');
    expect(prompt).not.toContain('Presentaciones:');
    expect(prompt).not.toContain('Negocio:');
  });
});

describe('parseProfileSuggestion', () => {
  it('lee el JSON y lo sanea', () => {
    expect(
      parseProfileSuggestion(
        '{"description":"  Contenedor  de icopor ","uses":["hamburguesa","hamburguesa",""],"attributes":[{"name":"compartimentos","value":2}],"aliases":["portacomida"]}',
      ),
    ).toEqual({
      description: 'Contenedor de icopor',
      uses: ['hamburguesa'],
      attributes: [{ name: 'compartimentos', value: '2' }],
      aliases: ['portacomida'],
    });
  });

  it('tolera bloques ```json``` y texto alrededor', () => {
    const result = parseProfileSuggestion('Claro:\n```json\n{"description":"Algo útil"}\n```');
    expect(result?.description).toBe('Algo útil');
  });

  it('sin JSON, JSON inválido, lista o todo vacío → null', () => {
    expect(parseProfileSuggestion('no sé')).toBeNull();
    expect(parseProfileSuggestion('{ roto')).toBeNull();
    expect(parseProfileSuggestion('{"a": [1,}')).toBeNull();
    expect(parseProfileSuggestion('{"description":"","uses":[]}')).toBeNull();
  });

  it('nunca acepta relacionados propuestos por la IA', () => {
    const result = parseProfileSuggestion(
      '{"description":"x","related":[{"product_id":1,"kind":"upgrade"}]}',
    );
    expect(result).not.toHaveProperty('related');
  });
});
