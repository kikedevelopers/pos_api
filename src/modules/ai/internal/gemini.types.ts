/**
 * Tipos del protocolo de Google Gemini (`generateContent` / `streamGenerateContent`)
 * y del contrato interno del módulo `ai`.
 *
 * Solo modelamos lo que realmente usamos: texto y function calling. Las partes
 * desconocidas (p.ej. `thoughtSignature` de los modelos con razonamiento) se
 * preservan tal cual porque hay que devolvérselas al modelo en la siguiente
 * ronda; por eso `GeminiPart` es abierto.
 */

export type ChatRole = 'user' | 'assistant';

/** Un turno del historial tal y como lo manda el cliente. */
export interface ChatTurn {
  role: ChatRole;
  content: string;
}

export interface GeminiFunctionCall {
  name: string;
  args?: Record<string, unknown>;
}

export interface GeminiFunctionResponse {
  name: string;
  response: Record<string, unknown>;
}

export interface GeminiPart {
  text?: string;
  functionCall?: GeminiFunctionCall;
  functionResponse?: GeminiFunctionResponse;
  /** Marca las partes de "razonamiento": no se muestran al usuario. */
  thought?: boolean;
  /** Firma opaca del razonamiento; se devuelve intacta en la siguiente ronda. */
  thoughtSignature?: string;
  [key: string]: unknown;
}

export interface GeminiContent {
  role: 'user' | 'model';
  parts: GeminiPart[];
}

/** Declaración de una herramienta (JSON Schema recortado que acepta Google). */
export interface GeminiFunctionDeclaration {
  name: string;
  description: string;
  parameters?: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

export interface GeminiRequestBody {
  contents: GeminiContent[];
  systemInstruction?: { parts: GeminiPart[] };
  generationConfig: {
    temperature: number;
    topP: number;
    maxOutputTokens: number;
  };
  tools?: [{ functionDeclarations: GeminiFunctionDeclaration[] }];
}

/** Un evento SSE ya parseado del stream de Gemini. */
export interface GeminiStreamEvent {
  /** Texto visible acumulable (excluye partes de razonamiento). */
  text: string;
  /** Partes crudas del candidato, para reenviarlas en la siguiente ronda. */
  parts: GeminiPart[];
  functionCalls: GeminiFunctionCall[];
  finishReason?: string;
  /** Motivo por el que el prompt fue bloqueado por seguridad, si aplica. */
  blockReason?: string;
  /** Error embebido en el propio stream (Google los manda como data JSON). */
  error?: string;
}
