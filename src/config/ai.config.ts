import { registerAs } from '@nestjs/config';

/**
 * Configuración de PlacePOS IA (Google Gemini).
 *
 * La llave vive SOLO aquí, en el servidor: el cliente (Electron/PWA) nunca la
 * ve. El chat es cloud-only justamente por esto y porque el asistente consulta
 * la base de datos del tenant.
 */
export interface AiConfig {
  /** API key de Google AI Studio. Vacío = la feature responde 503. */
  apiKey: string;
  /** Base de la API generativa (se puede apuntar a un proxy corporativo). */
  baseUrl: string;
  /** Modelo por defecto cuando el cliente no pide uno. */
  defaultModel: string;
  /** Modelos que el cliente puede elegir. Cualquier otro se rechaza (400). */
  allowedModels: string[];
  temperature: number;
  maxOutputTokens: number;
  /** Corte duro de la petición HTTP a Google. */
  requestTimeoutMs: number;
  /**
   * Cuántas rondas de function calling se permiten antes de obligar al modelo
   * a responder con texto. Evita bucles infinitos de herramientas.
   */
  maxToolRounds: number;
}

/**
 * Alias "latest" a propósito: apuntan siempre al modelo vigente de cada familia
 * y sobreviven a las jubilaciones. Los `gemini-2.5-*` ya NO se pueden usar en
 * proyectos nuevos ("no longer available to new users"), así que no van de
 * defecto — ni siquiera `gemini-2.5-flash-lite`, que la API lista pero rechaza
 * con 404 al generar.
 *
 * El primero de la lista es el de defecto: Flash-Lite, el más rápido y barato,
 * que es lo que necesita un asistente que sobre todo lee datos y los resume.
 */
const DEFAULT_MODELS = ['gemini-flash-lite-latest', 'gemini-flash-latest', 'gemini-pro-latest'];

const parseList = (raw: string | undefined, fallback: string[]): string[] => {
  const parsed = (raw ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  return parsed.length > 0 ? parsed : fallback;
};

export default registerAs<AiConfig>('ai', () => {
  const defaultModel = process.env.GEMINI_DEFAULT_MODEL?.trim() || DEFAULT_MODELS[0];
  const allowedModels = parseList(process.env.GEMINI_ALLOWED_MODELS, DEFAULT_MODELS);

  return {
    apiKey: process.env.GEMINI_API_KEY?.trim() ?? '',
    baseUrl: (
      process.env.GEMINI_BASE_URL?.trim() || 'https://generativelanguage.googleapis.com/v1beta'
    ).replace(/\/+$/, ''),
    defaultModel,
    // El modelo por defecto SIEMPRE es elegible aunque no esté en la lista.
    allowedModels: allowedModels.includes(defaultModel)
      ? allowedModels
      : [defaultModel, ...allowedModels],
    temperature: Number.parseFloat(process.env.GEMINI_TEMPERATURE ?? '0.7'),
    maxOutputTokens: Number.parseInt(process.env.GEMINI_MAX_OUTPUT_TOKENS ?? '4096', 10),
    requestTimeoutMs: Number.parseInt(process.env.GEMINI_REQUEST_TIMEOUT_MS ?? '120000', 10),
    maxToolRounds: Number.parseInt(process.env.GEMINI_MAX_TOOL_ROUNDS ?? '4', 10),
  };
});
