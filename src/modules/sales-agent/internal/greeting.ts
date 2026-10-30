import type { SellerPersonality } from './seller-prompt';

/** Franja del día en hora Colombia, para el saludo ("buenos días"...). */
export type TimeOfDay = 'manana' | 'tarde' | 'noche';

/**
 * Franja según la hora local (0–23): 5–11 mañana, 12–18 tarde, resto noche.
 * Una hora fuera de rango se trata como noche.
 */
export const timeOfDayFromHour = (hour: number): TimeOfDay => {
  if (hour >= 5 && hour <= 11) return 'manana';
  if (hour >= 12 && hour <= 18) return 'tarde';
  return 'noche';
};

/** "Buenos días" / "Buenas tardes" / "Buenas noches". */
export const greetingPhrase = (timeOfDay: TimeOfDay): string => {
  if (timeOfDay === 'manana') return 'Buenos días';
  if (timeOfDay === 'tarde') return 'Buenas tardes';
  return 'Buenas noches';
};

export interface SellerGreetingParams {
  assistantName: string;
  businessName: string;
  personality: SellerPersonality;
  timeOfDay: TimeOfDay;
}

/**
 * Saludo + presentación del vendedor, en el tono de su personalidad. Se usa tal
 * cual cuando el cliente reinicia la conversación (/start) y como EJEMPLO de
 * tono en el prompt para el primer mensaje del día.
 */
export const buildSellerGreeting = ({
  assistantName,
  businessName,
  personality,
  timeOfDay,
}: SellerGreetingParams): string => {
  const phrase = greetingPhrase(timeOfDay);
  switch (personality) {
    case 'directo_comercial':
      return `${phrase}, soy ${assistantName} de ${businessName}. ¿Qué necesitas?`;
    case 'formal_corporativo':
      return `${phrase}. Le saluda ${assistantName}, de ${businessName}. ¿En qué puedo servirle?`;
    case 'amable_profesional':
    default:
      return `¡${phrase}! 😊 Soy ${assistantName}, de ${businessName}. ¡Qué gusto saludarte! ¿En qué te puedo ayudar hoy?`;
  }
};
