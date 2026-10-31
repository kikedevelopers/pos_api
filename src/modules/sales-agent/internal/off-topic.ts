/**
 * Filtro de mensajes FUERA DE TEMA (anti-troll). Funciones puras: el prompt del
 * clasificador mínimo y la lectura de su respuesta.
 *
 * Mientras una conversación está en silencio, cada mensaje pasa por este
 * clasificador (unas decenas de tokens) en vez de por el agente completo (miles
 * de tokens con su prompt y herramientas). Solo si es algo del negocio, el
 * agente vuelve a responder.
 */

/** Largo máximo del mensaje que se clasifica (lo demás no aporta). */
export const MAX_CLASSIFIED_MESSAGE_LEN = 400;

export const buildOffTopicClassifierPrompt = (params: {
  businessName: string;
  categories?: readonly string[];
  message: string;
}): string => {
  const categories = (params.categories ?? []).slice(0, 25).join(', ');
  const message = params.message.replace(/\s+/g, ' ').trim().slice(0, MAX_CLASSIFIED_MESSAGE_LEN);
  return [
    `Eres el filtro de mensajes de "${params.businessName}"${categories ? ` (vende: ${categories})` : ''}.`,
    'Responde SOLO "SI" o "NO".',
    'SI: el mensaje es una consulta real para el negocio: comprar, un producto, precios, existencias, un pedido, entregas, pagos, horario o ubicación.',
    'NO: saludos sueltos, bromas, provocaciones, preguntas sobre ti (si eres un bot, si existes, si tienes sentimientos), drogas, sexo, insultos, temas ajenos al negocio o mensajes sin sentido.',
    `Mensaje: «${message}»`,
  ].join('\n');
};

/** Lee la respuesta del clasificador: solo un "SI" claro cuenta como del negocio. */
export const parseOffTopicVerdict = (text: string): boolean =>
  // Sin `\b`: en JS no trata la "í" como letra ("Sí" no se reconocería).
  /^[^a-záéíóúñ]*s[ií](?![a-záéíóúñ])/i.test(text.trim());

/** Qué decirle al agente cuando marca un mensaje fuera de tema. */
export const offTopicToolMessage = (strikes: number, limit: number): string =>
  strikes >= limit
    ? 'LÍMITE ALCANZADO. Despídete ahora con amabilidad en UNA frase: dile que aquí estarás cuando necesite algo del negocio (productos o un pedido). Sin preguntas, sin emojis de más. Después de esto no responderás más mensajes que no sean del negocio.'
    : 'Anotado. Responde en UNA frase corta y amable, sin explicarte ni debatir, y redirige a lo que vende el negocio. No menciones avisos, conteos ni que vas a dejar de responder.';
