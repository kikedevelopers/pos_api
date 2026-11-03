import {
  buildFollowUpPrompt,
  fallbackFollowUpMessage,
  firstNameOf,
  naturalProductName,
  FOLLOW_UP_MAX_LENGTH,
  FOLLOW_UP_MAX_SUGGESTIONS,
  normalizeFollowUpMessage,
  parseFollowUpDraft,
  type FollowUpPromptInput,
} from '../internal/follow-up-prompt';

const baseInput = (overrides: Partial<FollowUpPromptInput> = {}): FollowUpPromptInput => ({
  businessName: 'Esencia & Grano',
  assistantName: 'Andrea',
  personality: 'amable_profesional',
  customerName: 'JULIO CÉSAR PÉREZ',
  timeOfDay: 'manana',
  daysSinceLastPurchase: 12,
  recentSales: [{ date: '2026-10-20', items: ['UVA PASA', 'CANELA'] }],
  purchased: [
    {
      id: 10,
      name: 'UVA PASA',
      category: 'Frutos secos',
      last_bought: '2026-10-20',
      times: 2,
      in_stock: true,
      restocked: true,
    },
    {
      id: 11,
      name: 'CANELA',
      category: 'Especias',
      last_bought: '2026-10-20',
      times: 1,
      in_stock: false,
      restocked: false,
    },
  ],
  catalog: [
    { id: 20, name: 'ARANDANOS', category: 'Frutos secos', complements: [10] },
    { id: 21, name: 'MANI', category: 'Frutos secos', description: 'Maní tostado sin sal' },
  ],
  hideStock: false,
  ...overrides,
});

const allowed = {
  purchased: new Set([10, 11]),
  catalog: new Set([20, 21, 22, 23]),
  outOfStock: new Set([11]),
};

const json = (value: unknown): string => JSON.stringify(value);
const MESSAGE =
  '¡Hola, Julio! 👋 Te saludamos de *Esencia & Grano*.\n\nYa tenemos uvas pasas nuevas y unos arándanos que combinan perfecto. ¿Te los apartamos?';

describe('firstNameOf', () => {
  it('toma el primer nombre en formato título', () => {
    expect(firstNameOf('ANA MARÍA ORTIZ')).toBe('Ana');
    expect(firstNameOf('  jhoana   mogollon ')).toBe('Jhoana');
  });

  it('vacío si no hay nombre', () => {
    expect(firstNameOf('   ')).toBe('');
  });
});

describe('buildFollowUpPrompt', () => {
  it('incluye negocio, agente, cliente por su primer nombre y la franja del día', () => {
    const prompt = buildFollowUpPrompt(baseInput());
    expect(prompt).toContain('Eres Andrea, del equipo de Esencia & Grano');
    expect(prompt).toContain('a Julio');
    expect(prompt).toContain('mañana (buenos días)');
    expect(prompt).toContain('hace 12 día(s)');
  });

  it('lista SOLO lo comprado y lo del catálogo, con ids, stock y complementos', () => {
    const prompt = buildFollowUpPrompt(baseInput());
    expect(prompt).toContain('id 10 · "Uva pasa"');
    expect(prompt).toContain('ENTRÓ MERCANCÍA NUEVA');
    expect(prompt).toContain('id 11 · "Canela"');
    expect(prompt).toContain('HOY SIN EXISTENCIAS');
    expect(prompt).toContain('COMPLEMENTA a: Uva pasa');
    expect(prompt).toContain('Maní tostado sin sal');
    expect(prompt).toContain('- 2026-10-20: Uva pasa, Canela');
  });

  it('reglas de oro: no inventar productos ni compras, sin precios', () => {
    const prompt = buildFollowUpPrompt(baseInput());
    expect(prompt).toContain('NUNCA inventes productos');
    expect(prompt).toContain('NUNCA digas que el cliente compró algo');
    expect(prompt).toContain('No menciones precios');
  });

  it('con "ofrecer siempre" no habla de existencias', () => {
    const prompt = buildFollowUpPrompt(baseInput({ hideStock: true }));
    expect(prompt).not.toContain('ENTRÓ MERCANCÍA NUEVA');
    expect(prompt).not.toContain('HOY SIN EXISTENCIAS');
    expect(prompt).toContain('NO hables de existencias');
  });

  it('pide un mensaje distinto a los borradores descartados', () => {
    const prompt = buildFollowUpPrompt(baseInput({ previousDrafts: ['Hola Julio, borrador 1', '  '] }));
    expect(prompt).toContain('YA DESCARTÓ');
    expect(prompt).toContain('Hola Julio, borrador 1');
    expect(prompt).not.toContain('Borrador 2');
  });

  it('sin catálogo ni compras lo dice explícitamente (no sugiere)', () => {
    const prompt = buildFollowUpPrompt(
      baseInput({ catalog: [], purchased: [], recentSales: [], daysSinceLastPurchase: null }),
    );
    expect(prompt).toContain('catálogo vacío: NO sugieras productos');
    expect(prompt).toContain('no hay compras registradas');
    expect(prompt).toContain('No se sabe cuándo compró');
  });

  it('respeta el estilo propio del dueño y el trato de "usted" en formal', () => {
    const prompt = buildFollowUpPrompt(
      baseInput({ personality: 'formal_corporativo', greetingStyle: 'Siempre con un 🌿' }),
    );
    expect(prompt).toContain('trato de "usted"');
    expect(prompt).toContain('Siempre con un 🌿');
  });
});

describe('parseFollowUpDraft', () => {
  it('acepta un borrador válido y normaliza los saltos', () => {
    const result = parseFollowUpDraft(
      json({
        message: `${MESSAGE}\r\n\r\n\r\n¡Un abrazo!   `,
        recalled_product_ids: [10],
        suggested_product_ids: [20, '21', 20],
      }),
      allowed,
    );
    expect(result).toEqual({
      ok: true,
      draft: {
        message: `${MESSAGE}\n\n¡Un abrazo!`,
        recalled_product_ids: [10],
        suggested_product_ids: [20, 21],
      },
    });
  });

  it('acepta el JSON dentro de un bloque ```json', () => {
    const result = parseFollowUpDraft(
      '```json\n' + json({ message: MESSAGE, recalled_product_ids: [], suggested_product_ids: [] }) + '\n```',
      allowed,
    );
    expect(result.ok).toBe(true);
  });

  it('listas ausentes cuentan como vacías', () => {
    const result = parseFollowUpDraft(json({ message: MESSAGE }), allowed);
    expect(result).toMatchObject({ ok: true, draft: { recalled_product_ids: [], suggested_product_ids: [] } });
  });

  it('rechaza un "recuerdo" de algo que el cliente NO compró', () => {
    const result = parseFollowUpDraft(
      json({ message: MESSAGE, recalled_product_ids: [20], suggested_product_ids: [] }),
      allowed,
    );
    expect(result).toEqual({ ok: false, reason: expect.stringContaining('NO compró (ids 20)') });
  });

  it('rechaza sugerencias que no están en el catálogo (producto inventado)', () => {
    const result = parseFollowUpDraft(
      json({ message: MESSAGE, recalled_product_ids: [], suggested_product_ids: [999] }),
      allowed,
    );
    expect(result).toEqual({ ok: false, reason: expect.stringContaining('no están en el catálogo') });
  });

  it('rechaza sugerir un producto comprado que está sin existencias', () => {
    const result = parseFollowUpDraft(
      json({ message: MESSAGE, recalled_product_ids: [], suggested_product_ids: [11] }),
      { ...allowed, catalog: new Set([11, 20]) },
    );
    expect(result).toEqual({ ok: false, reason: expect.stringContaining('sin existencias') });
  });

  it(`rechaza más de ${FOLLOW_UP_MAX_SUGGESTIONS} sugerencias`, () => {
    const result = parseFollowUpDraft(
      json({ message: MESSAGE, recalled_product_ids: [], suggested_product_ids: [20, 21, 22, 23] }),
      allowed,
    );
    expect(result).toEqual({ ok: false, reason: expect.stringContaining('Máximo') });
  });

  it.each([
    ['texto que no es JSON', 'Hola Julio'],
    ['un arreglo', json([1, 2])],
    ['mensaje corto', json({ message: 'Hola', recalled_product_ids: [], suggested_product_ids: [] })],
    ['mensaje no texto', json({ message: 42 })],
    ['ids no lista', json({ message: MESSAGE, recalled_product_ids: 10 })],
    ['ids no válidos', json({ message: MESSAGE, suggested_product_ids: [-1] })],
    ['ids decimales', json({ message: MESSAGE, suggested_product_ids: [2.5] })],
  ])('rechaza %s', (_label, raw) => {
    expect(parseFollowUpDraft(raw, allowed).ok).toBe(false);
  });

  it('rechaza un mensaje más largo que el límite', () => {
    const result = parseFollowUpDraft(
      json({ message: 'a'.repeat(FOLLOW_UP_MAX_LENGTH + 1) }),
      allowed,
    );
    expect(result).toEqual({ ok: false, reason: expect.stringContaining('supera') });
  });
});

describe('normalizeFollowUpMessage', () => {
  it('colapsa más de una línea en blanco y recorta', () => {
    expect(normalizeFollowUpMessage('  Hola  \n\n\n\nChao  ')).toBe('Hola\n\nChao');
  });
});

describe('fallbackFollowUpMessage', () => {
  const input = {
    customerName: 'ana ortiz',
    businessName: 'Esencia & Grano',
    assistantName: 'Andrea',
    timeOfDay: 'tarde' as const,
  };

  it('saluda por nombre, sin productos, con el tono de la personalidad', () => {
    const message = fallbackFollowUpMessage({ ...input, personality: 'amable_profesional' });
    expect(message).toContain('¡Buenas tardes, Ana!');
    expect(message).toContain('*Esencia & Grano*');
    expect(message).toContain('te podamos ayudar');
  });

  it('formal: trato de usted', () => {
    const message = fallbackFollowUpMessage({ ...input, personality: 'formal_corporativo' });
    expect(message).toContain('Buenas tardes, Ana.');
    expect(message).toContain('ayudarle');
  });

  it('sin nombre no deja una coma colgando', () => {
    const message = fallbackFollowUpMessage({ ...input, customerName: ' ', personality: 'directo_comercial' });
    expect(message.startsWith('¡Buenas tardes! ')).toBe(true);
  });
});

describe('naturalProductName', () => {
  it.each([
    ['GRANOLA X 500g', 'Granola'],
    ['ARANDANOS CJ X 11.34K', 'Arandanos'],
    ['ALMENDRA NATURAL X GRAMO', 'Almendra natural'],
    ['SAZONADOR X LIBRA', 'Sazonador'],
    ['MANI 500 GR', 'Mani'],
    ['COMINO MOLIDO PAQ.', 'Comino molido'],
    ['ESENCIA PRODEN - AREQUIPE', 'Esencia proden - arequipe'],
    ['CAMISA XL', 'Camisa xl'],
    ['CAFÉ EXPRESO', 'Café expreso'],
    ['X', 'X'],
  ])('%s → %s', (raw, expected) => {
    expect(naturalProductName(raw)).toBe(expected);
  });

  it('el prompt usa los nombres naturales, nunca el texto del inventario', () => {
    const prompt = buildFollowUpPrompt(
      baseInput({
        purchased: [{ id: 10, name: 'UVA PASA X LIBRA', category: null, last_bought: '2026-10-20', times: 1, in_stock: true, restocked: false }],
        catalog: [{ id: 20, name: 'ARANDANOS CJ X 11.34K', category: null }],
        recentSales: [{ date: '2026-10-20', items: ['UVA PASA X LIBRA'] }],
      }),
    );
    expect(prompt).toContain('"Uva pasa"');
    expect(prompt).toContain('"Arandanos"');
    expect(prompt).not.toContain('X LIBRA');
    expect(prompt).not.toContain('11.34K');
  });

  it('exige párrafos separados y trae un ejemplo de estilo', () => {
    const prompt = buildFollowUpPrompt(baseInput());
    expect(prompt).toContain('Nunca un solo bloque de texto');
    expect(prompt).toContain('Ejemplo de ESTILO (no lo copies');
  });
});
