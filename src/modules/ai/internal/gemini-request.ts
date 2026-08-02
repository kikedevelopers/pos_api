import type {
  ChatTurn,
  GeminiContent,
  GeminiFunctionDeclaration,
  GeminiRequestBody,
} from './gemini.types';

/**
 * Turnos del historial que viajan como contexto. Recortamos por el final (los
 * más recientes) para acotar prompt y costo.
 */
export const MAX_HISTORY_TURNS = 30;

/** Tope de caracteres por turno; blinda contra un cliente que mande un libro. */
export const MAX_TURN_CHARS = 8000;

export const DEFAULT_TOP_P = 0.95;

interface BuildParams {
  turns: ChatTurn[];
  systemPrompt?: string;
  temperature: number;
  maxOutputTokens: number;
  tools?: GeminiFunctionDeclaration[];
  maxHistoryTurns?: number;
}

const clamp = (value: number, min: number, max: number): number =>
  Math.min(Math.max(value, min), max);

/**
 * Traduce el historial del chat al body de `streamGenerateContent`.
 *
 * Reglas (por eso es puro y está testeado):
 *   - se descartan turnos vacíos/en blanco y roles desconocidos;
 *   - `assistant` → `model`;
 *   - la conversación DEBE empezar con `user`: si tras recortar quedan turnos
 *     del modelo al principio, se eliminan;
 *   - turnos consecutivos del mismo rol se fusionan (la API espera alternancia);
 *   - cada turno se trunca a `MAX_TURN_CHARS`.
 */
export const buildGeminiRequest = ({
  turns,
  systemPrompt,
  temperature,
  maxOutputTokens,
  tools,
  maxHistoryTurns = MAX_HISTORY_TURNS,
}: BuildParams): GeminiRequestBody => {
  const usable = (Array.isArray(turns) ? turns : [])
    .filter((turn) => turn?.role === 'user' || turn?.role === 'assistant')
    .map((turn) => ({
      role: turn.role,
      content: (turn.content ?? '').trim().slice(0, MAX_TURN_CHARS),
    }))
    .filter((turn) => turn.content.length > 0);

  const windowed = maxHistoryTurns > 0 ? usable.slice(-maxHistoryTurns) : usable;

  let start = 0;
  while (start < windowed.length && windowed[start].role === 'assistant') {
    start += 1;
  }

  const contents: GeminiContent[] = [];
  for (const turn of windowed.slice(start)) {
    const role = turn.role === 'assistant' ? 'model' : 'user';
    const previous = contents[contents.length - 1];
    if (previous && previous.role === role) {
      previous.parts[0].text = `${previous.parts[0].text ?? ''}\n\n${turn.content}`;
      continue;
    }
    contents.push({ role, parts: [{ text: turn.content }] });
  }

  const body: GeminiRequestBody = {
    contents,
    generationConfig: {
      temperature: clamp(temperature, 0, 2),
      topP: DEFAULT_TOP_P,
      maxOutputTokens: clamp(Math.trunc(maxOutputTokens), 256, 32768),
    },
  };

  const system = systemPrompt?.trim();
  if (system) {
    body.systemInstruction = { parts: [{ text: system }] };
  }

  if (tools && tools.length > 0) {
    body.tools = [{ functionDeclarations: tools }];
  }

  return body;
};

/** El body solo es enviable si hay al menos un turno del usuario con texto. */
export const hasSendableContent = (body: GeminiRequestBody): boolean =>
  body.contents.some(
    (content) => content.role === 'user' && (content.parts[0]?.text?.length ?? 0) > 0,
  );

/** URL del endpoint de streaming (SSE) para el modelo pedido. */
export const buildStreamUrl = (baseUrl: string, model: string, apiKey: string): string => {
  const base = baseUrl.replace(/\/+$/, '');
  const cleanModel = model.trim().replace(/^models\//, '');
  return `${base}/models/${encodeURIComponent(cleanModel)}:streamGenerateContent?alt=sse&key=${encodeURIComponent(apiKey)}`;
};
