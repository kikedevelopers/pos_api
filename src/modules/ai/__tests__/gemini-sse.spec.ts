import {
  describeBlockReason,
  describeFinishReason,
  parseGeminiEvent,
  splitSseEvents,
} from '../internal/gemini-sse';

describe('splitSseEvents', () => {
  it('extrae los eventos completos y deja el resto pendiente', () => {
    const { data, rest } = splitSseEvents('data: {"a":1}\n\ndata: {"b":2}\n\ndata: {"c"');

    expect(data).toEqual(['{"a":1}', '{"b":2}']);
    expect(rest).toBe('data: {"c"');
  });

  it('soporta CRLF', () => {
    const { data, rest } = splitSseEvents('data: uno\r\n\r\n');
    expect(data).toEqual(['uno']);
    expect(rest).toBe('');
  });

  it('ignora comentarios (heartbeat) y campos que no son data', () => {
    const { data } = splitSseEvents(': ping\n\nevent: message\nid: 7\ndata: hola\n\n');
    expect(data).toEqual(['hola']);
  });

  it('une varias líneas data del mismo evento', () => {
    const { data } = splitSseEvents('data: linea1\ndata: linea2\n\n');
    expect(data).toEqual(['linea1\nlinea2']);
  });

  it('no emite nada si aún no llegó el separador', () => {
    const { data, rest } = splitSseEvents('data: incompleto');
    expect(data).toEqual([]);
    expect(rest).toBe('data: incompleto');
  });
});

describe('parseGeminiEvent', () => {
  it('extrae el texto de las partes del candidato', () => {
    const event = parseGeminiEvent(
      JSON.stringify({
        candidates: [{ content: { role: 'model', parts: [{ text: 'Hola ' }, { text: 'mundo' }] } }],
      }),
    );

    expect(event.text).toBe('Hola mundo');
    expect(event.parts).toHaveLength(2);
    expect(event.functionCalls).toEqual([]);
  });

  it('omite del texto visible las partes de razonamiento pero las conserva crudas', () => {
    const event = parseGeminiEvent(
      JSON.stringify({
        candidates: [
          {
            content: {
              parts: [
                { text: 'pensando...', thought: true, thoughtSignature: 'sig' },
                { text: 'respuesta' },
              ],
            },
          },
        ],
      }),
    );

    expect(event.text).toBe('respuesta');
    expect(event.parts).toHaveLength(2);
    expect(event.parts[0].thoughtSignature).toBe('sig');
  });

  it('extrae las llamadas a herramientas con sus argumentos', () => {
    const event = parseGeminiEvent(
      JSON.stringify({
        candidates: [
          {
            content: {
              parts: [
                { functionCall: { name: 'get_daily_summary', args: { date: '2026-07-28' } } },
              ],
            },
          },
        ],
      }),
    );

    expect(event.functionCalls).toEqual([
      { name: 'get_daily_summary', args: { date: '2026-07-28' } },
    ]);
  });

  it('normaliza una functionCall sin args', () => {
    const event = parseGeminiEvent(
      JSON.stringify({
        candidates: [{ content: { parts: [{ functionCall: { name: 'get_treasury_accounts' } }] } }],
      }),
    );

    expect(event.functionCalls).toEqual([{ name: 'get_treasury_accounts', args: {} }]);
  });

  it('lee finishReason, blockReason y errores embebidos', () => {
    expect(
      parseGeminiEvent(JSON.stringify({ candidates: [{ finishReason: 'MAX_TOKENS' }] }))
        .finishReason,
    ).toBe('MAX_TOKENS');

    expect(
      parseGeminiEvent(JSON.stringify({ promptFeedback: { blockReason: 'SAFETY' } })).blockReason,
    ).toBe('SAFETY');

    expect(parseGeminiEvent(JSON.stringify({ error: { message: 'quota' } })).error).toBe('quota');
  });

  it('nunca lanza con payloads corruptos o vacíos', () => {
    for (const raw of ['', '   ', '[DONE]', '{no json', 'null', '[]', '{"candidates":"x"}']) {
      const event = parseGeminiEvent(raw);
      expect(event.text).toBe('');
      expect(event.functionCalls).toEqual([]);
    }
  });
});

describe('describeFinishReason', () => {
  it('no dice nada cuando el final es sano', () => {
    expect(describeFinishReason(undefined)).toBeNull();
    expect(describeFinishReason('STOP')).toBeNull();
    expect(describeFinishReason('FINISH_REASON_UNSPECIFIED')).toBeNull();
  });

  it('explica los cortes anómalos en español', () => {
    expect(describeFinishReason('MAX_TOKENS')).toContain('límite de longitud');
    expect(describeFinishReason('SAFETY')).toContain('seguridad');
    expect(describeFinishReason('RECITATION')).toContain('contenido protegido');
    expect(describeFinishReason('ALGO_RARO')).toContain('ALGO_RARO');
  });
});

describe('describeBlockReason', () => {
  it('devuelve null si no hubo bloqueo', () => {
    expect(describeBlockReason(undefined)).toBeNull();
  });

  it('explica el bloqueo del prompt', () => {
    expect(describeBlockReason('SAFETY')).toContain('bloqueado');
    expect(describeBlockReason('BLOCK_REASON_UNSPECIFIED')).toContain('rechazó');
  });
});
