import {
  buildFallbackGreeting,
  buildGreetingPrompt,
  describeTopics,
  joinTopics,
  MAX_GREETING_LENGTH,
  sanitizeGreeting,
} from '../internal/greeting';

describe('describeTopics', () => {
  it('traduce las herramientas a áreas del negocio, sin repetir', () => {
    expect(
      describeTopics(['get_daily_summary', 'list_sales', 'get_top_products', 'search_products']),
    ).toEqual(['ventas', 'inventario']);
  });

  it('mantiene un orden fijo aunque las herramientas lleguen desordenadas', () => {
    expect(describeTopics(['get_expenses_summary', 'get_treasury_accounts', 'list_sales'])).toEqual([
      'ventas',
      'caja',
      'gastos',
    ]);
  });

  it('ignora nombres desconocidos y listas vacías', () => {
    expect(describeTopics(['inventada', ''])).toEqual([]);
    expect(describeTopics([])).toEqual([]);
  });
});

describe('joinTopics', () => {
  it('usa "y" para unir el último', () => {
    expect(joinTopics(['ventas', 'caja', 'gastos'])).toBe('ventas, caja y gastos');
  });

  it('usa "e" cuando la palabra siguiente empieza por i', () => {
    expect(joinTopics(['ventas', 'inventario'])).toBe('ventas e inventario');
  });

  it('resuelve los casos de uno y de ninguno', () => {
    expect(joinTopics(['ventas'])).toBe('ventas');
    expect(joinTopics([])).toBe('');
  });
});

describe('buildFallbackGreeting', () => {
  it('nombra al negocio y a las áreas disponibles', () => {
    const text = buildFallbackGreeting({
      businessName: 'Esencia & Grano',
      topics: ['ventas', 'caja'],
    });

    expect(text).toContain('Soy Place');
    expect(text).toContain('Esencia & Grano');
    expect(text).toContain('ventas y caja');
    expect(text.length).toBeLessThanOrEqual(MAX_GREETING_LENGTH);
  });

  it('no promete datos cuando el usuario no tiene ninguna herramienta', () => {
    const text = buildFallbackGreeting({ businessName: 'La 21', topics: [] });

    expect(text).toContain('La 21');
    expect(text).not.toContain('Conozco');
  });
});

describe('buildGreetingPrompt', () => {
  it('exige el nombre literal del negocio y acota las áreas', () => {
    const prompt = buildGreetingPrompt({
      businessName: 'Esencia & Grano',
      topics: ['ventas', 'cartera'],
    });

    expect(prompt).toContain('EXACTAMENTE así');
    expect(prompt).toContain('Esencia & Grano');
    expect(prompt).toContain('ventas y cartera');
    expect(prompt).toContain('No prometas nada fuera de esa lista');
  });

  it('sin áreas, le prohíbe prometer informes', () => {
    const prompt = buildGreetingPrompt({ businessName: 'La 21', topics: [] });
    expect(prompt).toContain('no tiene informes habilitados');
  });

  it('pide una sola frase en texto plano', () => {
    const prompt = buildGreetingPrompt({ businessName: 'La 21', topics: ['ventas'] });
    expect(prompt).toContain('Una sola frase corta');
    expect(prompt).toContain('sin markdown');
  });
});

describe('sanitizeGreeting', () => {
  const business = 'Esencia & Grano';
  const valid = 'Soy Place, el asistente de Esencia & Grano: conozco tus ventas y tu caja.';

  it('acepta una frase válida', () => {
    expect(sanitizeGreeting(valid, business)).toBe(valid);
  });

  it('aplana saltos de línea y espacios repetidos', () => {
    expect(sanitizeGreeting('Soy Place,\n  el asistente de Esencia & Grano: pregúntame.', business)).toBe(
      'Soy Place, el asistente de Esencia & Grano: pregúntame.',
    );
  });

  it('quita el markdown que el modelo cuela', () => {
    expect(sanitizeGreeting(`**${valid}**`, business)).toBe(valid);
  });

  it('quita las comillas envolventes', () => {
    expect(sanitizeGreeting(`"${valid}"`, business)).toBe(valid);
    expect(sanitizeGreeting(`«${valid}»`, business)).toBe(valid);
  });

  it('RECHAZA un saludo que no nombra al negocio', () => {
    // La condición innegociable: si no lo nombra, no se muestra.
    expect(
      sanitizeGreeting('Soy Place, tu asistente de negocio. Pregúntame lo que necesites.', business),
    ).toBeNull();
  });

  it('acepta el nombre del negocio con otra capitalización', () => {
    expect(
      sanitizeGreeting('Soy Place, el asistente de ESENCIA & GRANO: pregúntame lo que sea.', business),
    ).not.toBeNull();
  });

  it('rechaza lo demasiado corto y lo demasiado largo', () => {
    expect(sanitizeGreeting('Hola.', business)).toBeNull();
    expect(sanitizeGreeting(`${valid} ${'muy largo '.repeat(40)}`, business)).toBeNull();
  });

  it('rechaza vacío, espacios y nulo', () => {
    expect(sanitizeGreeting('', business)).toBeNull();
    expect(sanitizeGreeting('    ', business)).toBeNull();
    expect(sanitizeGreeting(null, business)).toBeNull();
    expect(sanitizeGreeting(undefined, business)).toBeNull();
  });

  it('sin nombre de negocio no exige mencionarlo', () => {
    const text = 'Soy Place, tu asistente de negocio. Pregúntame lo que necesites.';
    expect(sanitizeGreeting(text, '   ')).toBe(text);
  });
});
