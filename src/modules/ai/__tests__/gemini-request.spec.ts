import {
  buildGeminiRequest,
  buildStreamUrl,
  hasSendableContent,
  MAX_TURN_CHARS,
} from '../internal/gemini-request';
import type { ChatTurn } from '../internal/gemini.types';

const base = {
  temperature: 0.7,
  maxOutputTokens: 4096,
};

describe('buildGeminiRequest', () => {
  it('mapea assistant→model y conserva el orden', () => {
    const turns: ChatTurn[] = [
      { role: 'user', content: 'Hola' },
      { role: 'assistant', content: 'Buenas' },
      { role: 'user', content: '¿Cuánto vendí hoy?' },
    ];

    const body = buildGeminiRequest({ turns, ...base });

    expect(body.contents).toEqual([
      { role: 'user', parts: [{ text: 'Hola' }] },
      { role: 'model', parts: [{ text: 'Buenas' }] },
      { role: 'user', parts: [{ text: '¿Cuánto vendí hoy?' }] },
    ]);
  });

  it('descarta turnos vacíos, en blanco y con rol desconocido', () => {
    const turns = [
      { role: 'system', content: 'ignórame' },
      { role: 'user', content: '   ' },
      { role: 'user', content: '  Hola  ' },
      { role: 'assistant', content: '' },
    ] as unknown as ChatTurn[];

    const body = buildGeminiRequest({ turns, ...base });

    expect(body.contents).toEqual([{ role: 'user', parts: [{ text: 'Hola' }] }]);
  });

  it('elimina los turnos del modelo que quedan al inicio', () => {
    const turns: ChatTurn[] = [
      { role: 'assistant', content: 'Saludo huérfano' },
      { role: 'user', content: 'Pregunta' },
    ];

    const body = buildGeminiRequest({ turns, ...base });

    expect(body.contents).toHaveLength(1);
    expect(body.contents[0].role).toBe('user');
  });

  it('fusiona turnos consecutivos del mismo rol', () => {
    const turns: ChatTurn[] = [
      { role: 'user', content: 'Uno' },
      { role: 'user', content: 'Dos' },
    ];

    const body = buildGeminiRequest({ turns, ...base });

    expect(body.contents).toEqual([{ role: 'user', parts: [{ text: 'Uno\n\nDos' }] }]);
  });

  it('recorta el historial a la ventana pedida quedándose con lo más reciente', () => {
    const turns: ChatTurn[] = [
      { role: 'user', content: 'viejo' },
      { role: 'assistant', content: 'respuesta vieja' },
      { role: 'user', content: 'nuevo' },
    ];

    const body = buildGeminiRequest({ turns, ...base, maxHistoryTurns: 1 });

    expect(body.contents).toEqual([{ role: 'user', parts: [{ text: 'nuevo' }] }]);
  });

  it('trunca un turno kilométrico a MAX_TURN_CHARS', () => {
    const turns: ChatTurn[] = [{ role: 'user', content: 'a'.repeat(MAX_TURN_CHARS + 500) }];

    const body = buildGeminiRequest({ turns, ...base });

    expect(body.contents[0].parts[0].text).toHaveLength(MAX_TURN_CHARS);
  });

  it('acota temperature y maxOutputTokens a rangos válidos', () => {
    const turns: ChatTurn[] = [{ role: 'user', content: 'Hola' }];

    const low = buildGeminiRequest({ turns, temperature: -5, maxOutputTokens: 10 });
    const high = buildGeminiRequest({ turns, temperature: 99, maxOutputTokens: 10_000_000 });

    expect(low.generationConfig.temperature).toBe(0);
    expect(low.generationConfig.maxOutputTokens).toBe(256);
    expect(high.generationConfig.temperature).toBe(2);
    expect(high.generationConfig.maxOutputTokens).toBe(32768);
  });

  it('incluye systemInstruction solo si el prompt tiene contenido', () => {
    const turns: ChatTurn[] = [{ role: 'user', content: 'Hola' }];

    expect(
      buildGeminiRequest({ turns, ...base, systemPrompt: '   ' }).systemInstruction,
    ).toBeUndefined();
    expect(
      buildGeminiRequest({ turns, ...base, systemPrompt: 'Eres X' }).systemInstruction,
    ).toEqual({
      parts: [{ text: 'Eres X' }],
    });
  });

  it('incluye tools solo si hay declaraciones', () => {
    const turns: ChatTurn[] = [{ role: 'user', content: 'Hola' }];

    expect(buildGeminiRequest({ turns, ...base, tools: [] }).tools).toBeUndefined();
    expect(
      buildGeminiRequest({
        turns,
        ...base,
        tools: [{ name: 'x', description: 'y' }],
      }).tools,
    ).toEqual([{ functionDeclarations: [{ name: 'x', description: 'y' }] }]);
  });

  it('no explota con entradas basura', () => {
    const body = buildGeminiRequest({ turns: null as unknown as ChatTurn[], ...base });
    expect(body.contents).toEqual([]);
  });
});

describe('hasSendableContent', () => {
  it('es false cuando no queda ningún turno del usuario', () => {
    const body = buildGeminiRequest({ turns: [], ...base });
    expect(hasSendableContent(body)).toBe(false);
  });

  it('es true con al menos un turno del usuario', () => {
    const body = buildGeminiRequest({ turns: [{ role: 'user', content: 'Hola' }], ...base });
    expect(hasSendableContent(body)).toBe(true);
  });
});

describe('buildStreamUrl', () => {
  it('arma la URL de streaming normalizando base y modelo', () => {
    const url = buildStreamUrl('https://api.google.com/v1beta/', 'models/gemini-2.5-flash', 'k-1');
    expect(url).toBe(
      'https://api.google.com/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse&key=k-1',
    );
  });

  it('escapa la llave y el modelo', () => {
    const url = buildStreamUrl('https://api.google.com/v1beta', 'a b', 'k/1');
    expect(url).toContain('models/a%20b:streamGenerateContent');
    expect(url).toContain('key=k%2F1');
  });
});
