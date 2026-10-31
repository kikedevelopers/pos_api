import { buildSellerGreeting, greetingPhrase, timeOfDayFromHour } from '../internal/greeting';

describe('timeOfDayFromHour', () => {
  it('5:00–11:59 es mañana', () => {
    expect(timeOfDayFromHour(5)).toBe('manana');
    expect(timeOfDayFromHour(11)).toBe('manana');
  });

  it('12:00–18:59 es tarde', () => {
    expect(timeOfDayFromHour(12)).toBe('tarde');
    expect(timeOfDayFromHour(18)).toBe('tarde');
  });

  it('19:00–4:59 es noche', () => {
    expect(timeOfDayFromHour(19)).toBe('noche');
    expect(timeOfDayFromHour(23)).toBe('noche');
    expect(timeOfDayFromHour(0)).toBe('noche');
    expect(timeOfDayFromHour(4)).toBe('noche');
  });

  it('una hora fuera de rango cae en noche', () => {
    expect(timeOfDayFromHour(-1)).toBe('noche');
    expect(timeOfDayFromHour(30)).toBe('noche');
  });
});

describe('greetingPhrase', () => {
  it('usa la frase de cada franja', () => {
    expect(greetingPhrase('manana')).toBe('Buenos días');
    expect(greetingPhrase('tarde')).toBe('Buenas tardes');
    expect(greetingPhrase('noche')).toBe('Buenas noches');
  });
});

describe('buildSellerGreeting', () => {
  const base = {
    assistantName: 'Andrea',
    businessName: 'Granero La 21',
    timeOfDay: 'manana' as const,
  };

  it('amable y profesional: cálido, con emoji y tuteo', () => {
    const text = buildSellerGreeting({ ...base, personality: 'amable_profesional' });
    expect(text).toContain('¡Buenos días!');
    expect(text).toContain('Soy Andrea, de Granero La 21');
    expect(text).toMatch(/te puedo ayudar/);
  });

  it('directo y comercial: corto y al grano', () => {
    const text = buildSellerGreeting({ ...base, personality: 'directo_comercial' });
    expect(text).toBe('Buenos días, soy Andrea de Granero La 21. ¿Qué necesitas?');
  });

  it('formal y corporativo: usted y sin emojis', () => {
    const text = buildSellerGreeting({ ...base, personality: 'formal_corporativo' });
    expect(text).toBe('Buenos días. Le saluda Andrea, de Granero La 21. ¿En qué puedo servirle?');
    expect(text).not.toMatch(/[\u{1F300}-\u{1FAFF}]/u);
  });

  it('respeta la franja horaria', () => {
    const text = buildSellerGreeting({
      ...base,
      timeOfDay: 'noche',
      personality: 'directo_comercial',
    });
    expect(text.startsWith('Buenas noches')).toBe(true);
  });
});
