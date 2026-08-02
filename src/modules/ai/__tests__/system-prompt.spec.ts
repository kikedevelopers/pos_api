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

  it('lista las herramientas disponibles del actor', () => {
    const prompt = buildSystemPrompt(context());
    expect(prompt).toContain('- get_daily_summary: Resumen del día');
  });

  it('avisa cuando el usuario no tiene ninguna herramienta', () => {
    const prompt = buildSystemPrompt(context({ availableTools: [] }));
    expect(prompt).toContain('ninguna');
  });

  it('bloquea el discurso de ganancias cuando el empleado no puede verlas', () => {
    const prompt = buildSystemPrompt(context({ canViewProfit: false }));
    expect(prompt).toContain('NO tiene permiso para ver costos');
  });

  it('recuerda las reglas financieras del negocio', () => {
    const prompt = buildSystemPrompt(context());
    expect(prompt).toContain('Los gastos se restan de la ganancia');
    expect(prompt).toContain('Excedente (reinversión)');
  });
});
