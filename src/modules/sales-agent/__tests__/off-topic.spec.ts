import {
  MAX_CLASSIFIED_MESSAGE_LEN,
  buildOffTopicClassifierPrompt,
  offTopicToolMessage,
  parseOffTopicVerdict,
} from '../internal/off-topic';

describe('buildOffTopicClassifierPrompt', () => {
  it('lleva el negocio, lo que vende, la regla y el mensaje', () => {
    const prompt = buildOffTopicClassifierPrompt({
      businessName: 'Esencia & Grano',
      categories: ['Especias', 'Granos'],
      message: '  ¿tienes\n canela? ',
    });
    expect(prompt).toContain('"Esencia & Grano" (vende: Especias, Granos)');
    expect(prompt).toContain('Responde SOLO "SI" o "NO".');
    expect(prompt).toMatch(/NO: saludos sueltos.*si tienes sentimientos.*drogas, sexo/s);
    expect(prompt).toContain('Mensaje: «¿tienes canela?»');
  });

  it('sin categorías no las menciona; recorta mensajes larguísimos', () => {
    const prompt = buildOffTopicClassifierPrompt({ businessName: 'X', message: 'a'.repeat(5000) });
    expect(prompt).not.toContain('vende:');
    expect(prompt).toContain(`«${'a'.repeat(MAX_CLASSIFIED_MESSAGE_LEN)}»`);
  });
});

describe('parseOffTopicVerdict', () => {
  it('solo un "SI" claro es del negocio', () => {
    for (const text of ['SI', 'Sí', 'si.', '  SI\n', '"SI"']) {
      expect(parseOffTopicVerdict(text)).toBe(true);
    }
    for (const text of ['NO', 'No.', '', 'Tal vez', 'sigue', 'SIN duda no']) {
      expect(parseOffTopicVerdict(text)).toBe(false);
    }
  });
});

describe('offTopicToolMessage', () => {
  it('antes del límite: una frase y redirigir, sin mencionar conteos', () => {
    expect(offTopicToolMessage(1, 3)).toMatch(/UNA frase corta.*No menciones avisos, conteos/s);
  });

  it('al llegar al límite: despedirse', () => {
    expect(offTopicToolMessage(3, 3)).toMatch(/^LÍMITE ALCANZADO\. Despídete/);
    expect(offTopicToolMessage(5, 3)).toMatch(/^LÍMITE ALCANZADO/);
  });
});
