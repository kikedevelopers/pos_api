import {
  ASSISTANT_NAME,
  buildSystemPrompt,
  type SystemPromptContext,
} from '../internal/system-prompt';

const context = (overrides: Partial<SystemPromptContext> = {}): SystemPromptContext => ({
  businessName: 'El Surtidor La 21',
  userName: 'Richard',
  userRole: 'dueño del negocio',
  today: '2026-07-28',
  availableTools: [{ name: 'get_daily_summary', description: 'Resumen del día' }],
  canViewProfit: true,
  ...overrides,
});

describe('buildSystemPrompt', () => {
  it('le da su identidad: se llama Place y no es "un modelo de lenguaje"', () => {
    const prompt = buildSystemPrompt(context());

    expect(ASSISTANT_NAME).toBe('Place');
    expect(prompt).toContain(`Eres **${ASSISTANT_NAME}**`);
    expect(prompt).toContain('Te llamas Place');
    expect(prompt).toContain('Nunca digas que eres Gemini');
  });

  it('declara su razón de ser', () => {
    expect(buildSystemPrompt(context())).toContain('Tu razón de ser');
  });

  it('lo ata a este negocio y le prohíbe hablar de otros', () => {
    const prompt = buildSystemPrompt(context());
    expect(prompt).toContain('solo con SUS datos');
    expect(prompt).toContain('ni tienes acceso a internet');
  });

  it('incluye negocio, usuario y fecha', () => {
    const prompt = buildSystemPrompt(context());

    expect(prompt).toContain('El Surtidor La 21');
    expect(prompt).toContain('Richard');
    expect(prompt).toContain('2026-07-28');
    expect(prompt).toContain('America/Bogota');
  });

  it('prohíbe inventar cifras', () => {
    expect(buildSystemPrompt(context())).toContain('Nunca inventes');
  });

  it('lista las herramientas disponibles del actor (solo nombres)', () => {
    const prompt = buildSystemPrompt(
      context({
        availableTools: [
          { name: 'get_daily_summary', description: 'Resumen financiero de un día: ventas…' },
          { name: 'list_sales', description: 'Lista las ventas de un día una por una…' },
        ],
      }),
    );
    expect(prompt).toContain('- get_daily_summary, list_sales.');
  });

  it('NO repite las descripciones de las herramientas (ya van en sus declaraciones)', () => {
    const description = 'Resumen financiero de un día: ventas en efectivo, consignaciones…';
    const prompt = buildSystemPrompt(
      context({ availableTools: [{ name: 'get_daily_summary', description }] }),
    );
    expect(prompt).not.toContain(description);
  });

  it('lo que cambia (negocio, usuario, fecha) va AL FINAL: el inicio es idéntico entre negocios y días', () => {
    const a = buildSystemPrompt(context());
    const b = buildSystemPrompt(
      context({
        businessName: 'Otra Tienda',
        userName: 'Ana',
        userRole: 'empleado',
        today: '2026-12-01',
      }),
    );
    const marker = 'CONTEXTO DE ESTA CONVERSACIÓN';
    expect(a.slice(0, a.indexOf(marker))).toBe(b.slice(0, b.indexOf(marker)));
    expect(a.trimEnd().endsWith('(zona horaria America/Bogota)')).toBe(true);
    expect(a.indexOf(marker)).toBeGreaterThan(a.indexOf('ESTILO'));
  });

  it('avisa cuando el usuario no tiene ninguna herramienta', () => {
    const prompt = buildSystemPrompt(context({ availableTools: [] }));
    expect(prompt).toContain('ninguna');
  });

  it('bloquea el discurso de ganancias cuando el empleado no puede verlas', () => {
    const prompt = buildSystemPrompt(context({ canViewProfit: false }));
    expect(prompt).toContain('NO tiene permiso para ver costos');
  });

  it('sin herramientas de gastos sigue siendo de solo lectura', () => {
    const prompt = buildSystemPrompt(context());
    expect(prompt).toContain('solo puedes leer información, nunca modificarla');
    expect(prompt).not.toContain('GASTOS: REGISTRAR Y ARCHIVAR');
  });

  it('con herramientas de gastos (administrador) explica el flujo de dos pasos', () => {
    const prompt = buildSystemPrompt(
      context({
        availableTools: [
          { name: 'register_expense', description: 'x' },
          { name: 'void_expense', description: 'x' },
          { name: 'confirm_expense_action', description: 'x' },
        ],
      }),
    );
    expect(prompt).toContain('GASTOS: REGISTRAR Y ARCHIVAR');
    expect(prompt).toContain('NUNCA inventes, supongas ni completes ninguno');
    expect(prompt).toContain('Nunca prepares y confirmes en la misma respuesta');
    expect(prompt).toContain('status "executed"');
    expect(prompt).toContain('Los gastos NO se editan');
    expect(prompt).not.toContain('solo puedes leer información, nunca modificarla');
  });

  it('sin la herramienta de pedidos no menciona las reglas de ventas', () => {
    const prompt = buildSystemPrompt(context());
    expect(prompt).not.toContain('VENTAS: REGISTRAR UN PEDIDO POR COBRAR');
  });

  it('con la herramienta de pedidos explica interpretar, sugerir tamaños y confirmar', () => {
    const prompt = buildSystemPrompt(
      context({
        availableTools: [
          { name: 'prepare_sale', description: 'x' },
          { name: 'confirm_sale', description: 'x' },
        ],
      }),
    );
    expect(prompt).toContain('VENTAS: REGISTRAR UN PEDIDO POR COBRAR');
    expect(prompt).toContain('"alternatives"');
    expect(prompt).toContain('primero los menores');
    expect(prompt).toContain('Llama confirm_sale SOLO cuando');
    expect(prompt).toContain('Nunca prepares y confirmes en la misma respuesta');
    expect(prompt).toContain('registrar ventas como PEDIDO POR COBRAR');
    expect(prompt).not.toContain('solo puedes leer información, nunca modificarla');
    expect(prompt).not.toContain('GASTOS: REGISTRAR Y ARCHIVAR');
  });

  it('con gastos y pedidos lista ambas modificaciones permitidas', () => {
    const prompt = buildSystemPrompt(
      context({
        availableTools: [
          { name: 'register_expense', description: 'x' },
          { name: 'prepare_sale', description: 'x' },
        ],
      }),
    );
    expect(prompt).toContain(
      'registrar y archivar GASTOS VARIABLES y registrar ventas como PEDIDO POR COBRAR',
    );
    expect(prompt).toContain('GASTOS: REGISTRAR Y ARCHIVAR');
    expect(prompt).toContain('VENTAS: REGISTRAR UN PEDIDO POR COBRAR');
  });

  it('sin las herramientas de tesorería no menciona sus reglas y prohíbe mover/ajustar saldos', () => {
    const prompt = buildSystemPrompt(
      context({ availableTools: [{ name: 'register_expense', description: 'x' }] }),
    );
    expect(prompt).not.toContain('TESORERÍA: MOVER Y CORREGIR SALDOS');
    expect(prompt).toContain('mover o ajustar saldos');
  });

  it('con tesorería (dueño) explica mover vs. corregir al saldo FINAL y la tarjeta', () => {
    const prompt = buildSystemPrompt(
      context({
        availableTools: [
          { name: 'prepare_treasury_transfer', description: 'x' },
          { name: 'prepare_balance_correction', description: 'x' },
          { name: 'confirm_treasury_action', description: 'x' },
        ],
      }),
    );
    expect(prompt).toContain('TESORERÍA: MOVER Y CORREGIR SALDOS');
    expect(prompt).toContain('X es el saldo FINAL, no la diferencia');
    expect(prompt).toContain('Nunca supongas cuenta ni valor');
    expect(prompt).toContain('NO la repitas');
    expect(prompt).toContain('MOVER y CORREGIR saldos de cajas, bancos y billeteras');
    expect(prompt).not.toContain('mover o ajustar saldos');
    expect(prompt).not.toContain('solo puedes leer información, nunca modificarla');
  });

  it('recuerda las reglas financieras del negocio', () => {
    const prompt = buildSystemPrompt(context());
    expect(prompt).toContain('Los gastos se restan de la ganancia');
    expect(prompt).toContain('Excedente (reinversión)');
  });

  describe('negocios del dueño (sucursales)', () => {
    const MAIN = { id: 10, name: 'El Surtidor La 21', is_branch: false, is_active: true };
    const NORTE = { id: 11, name: 'Sucursal Norte', is_branch: true, is_active: true };

    it('sin negocios (empleado) no habla de sucursales ni agrega reglas', () => {
      const prompt = buildSystemPrompt(context());
      expect(prompt).not.toContain('TUS NEGOCIOS');
      expect(prompt).not.toContain('VARIOS NEGOCIOS');
    });

    it('owner sin sucursales: le dice que solo tiene el principal, sin reglas multi-negocio', () => {
      const prompt = buildSystemPrompt(context({ businesses: [MAIN], current_company_id: 10 }));
      expect(prompt).toContain('solo el negocio principal (El Surtidor La 21)');
      expect(prompt).toContain('NO tiene sucursales');
      expect(prompt).not.toContain('VARIOS NEGOCIOS');
    });

    it('owner con sucursales: lista compacta con el actual + reglas de uso', () => {
      const prompt = buildSystemPrompt(
        context({ businesses: [MAIN, NORTE], current_company_id: 11 }),
      );
      expect(prompt).toContain('VARIOS NEGOCIOS');
      expect(prompt).toContain('get_businesses_overview');
      expect(prompt).toContain('business_id');
      expect(prompt).toContain('#10 El Surtidor La 21 (principal)');
      expect(prompt).toContain('#11 Sucursal Norte (sucursal, ACTUAL)');
      expect(prompt).toContain('Gastos y pedidos solo en el negocio ACTUAL');
      expect(prompt).toContain('nunca escribas el # ni business_id');
    });

    it('la lista de negocios va AL FINAL y las reglas fijas antes del contexto (prefijo cacheable)', () => {
      const prompt = buildSystemPrompt(
        context({ businesses: [MAIN, NORTE], current_company_id: 10 }),
      );
      const marker = 'CONTEXTO DE ESTA CONVERSACIÓN';
      expect(prompt.indexOf('VARIOS NEGOCIOS')).toBeLessThan(prompt.indexOf(marker));
      expect(prompt.indexOf('TUS NEGOCIOS (')).toBeGreaterThan(prompt.indexOf(marker));
      expect(prompt.trimEnd().endsWith('#11 Sucursal Norte (sucursal)')).toBe(true);

      // Dos owners multi-negocio distintos comparten todo hasta el contexto.
      const other = buildSystemPrompt(
        context({
          businessName: 'Otra',
          businesses: [
            { ...MAIN, id: 50, name: 'Otra' },
            { ...NORTE, id: 51 },
          ],
          current_company_id: 50,
        }),
      );
      expect(prompt.slice(0, prompt.indexOf(marker))).toBe(other.slice(0, other.indexOf(marker)));
    });
  });
});
