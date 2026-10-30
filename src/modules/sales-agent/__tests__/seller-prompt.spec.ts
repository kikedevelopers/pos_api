import { buildSellerSystemPrompt, SELLER_ASSISTANT_NAME } from '../internal/seller-prompt';

describe('buildSellerSystemPrompt', () => {
  const base = { businessName: 'Granero La 21', today: '2026-10-29' };

  it('se presenta como Place, vendedor del negocio por su nombre', () => {
    const prompt = buildSellerSystemPrompt(base);
    expect(SELLER_ASSISTANT_NAME).toBe('Place');
    expect(prompt).toContain('Place');
    expect(prompt).toContain('Granero La 21');
    expect(prompt).toContain('2026-10-29');
  });

  it('prohíbe revelar costos, márgenes e información interna', () => {
    const prompt = buildSellerSystemPrompt(base);
    expect(prompt).toMatch(/costos/i);
    expect(prompt).toMatch(/márgenes|ganancias/i);
    expect(prompt).toMatch(/nunca inventes/i);
  });

  it('le exige consultar inventario real antes de afirmar precio o stock', () => {
    const prompt = buildSellerSystemPrompt(base);
    expect(prompt).toMatch(/inventario real|Consulta SIEMPRE el inventario/i);
  });

  it('no revela las existencias exactas al cliente (solo como táctica)', () => {
    const prompt = buildSellerSystemPrompt(base);
    expect(prompt).toMatch(/NUNCA le sueltes al cliente la cantidad exacta/i);
  });

  it('pide texto plano (sin markdown/asteriscos)', () => {
    const prompt = buildSellerSystemPrompt(base);
    expect(prompt).toMatch(/TEXTO PLANO/i);
    expect(prompt).toMatch(/markdown|asteriscos/i);
  });

  it('pide nombrar el producto por su presentación, conciso', () => {
    const prompt = buildSellerSystemPrompt(base);
    expect(prompt).toMatch(/PRESENTACIÓN/i);
  });

  it('cotiza con el PRIMER precio de la lista y mantiene consistencia', () => {
    const prompt = buildSellerSystemPrompt(base);
    expect(prompt).toMatch(/PRIMER precio de la lista/i);
    expect(prompt).toMatch(/CONSISTENCIA|mismo precio/i);
  });

  it('exige dar el precio aunque esté agotado', () => {
    const prompt = buildSellerSystemPrompt(base);
    expect(prompt).toMatch(/DÁLO de inmediato/i);
    expect(prompt).toMatch(/exista o no/i);
  });

  it('cierra de forma honesta (no "registrado en el sistema") y una sola vez', () => {
    const prompt = buildSellerSystemPrompt(base);
    expect(prompt).toMatch(/UNA SOLA\s+VEZ por pedido/i);
    expect(prompt).toMatch(/registrado en el sistema/i);
    expect(prompt).toMatch(/TOMAS el pedido/i);
  });

  it('incluye el nombre del cliente cuando el canal lo entrega', () => {
    const prompt = buildSellerSystemPrompt({ ...base, customerName: 'María' });
    expect(prompt).toContain('María');
  });

  it('no dice que es una IA y cubre venta cruzada y cierre', () => {
    const prompt = buildSellerSystemPrompt(base);
    expect(prompt).toMatch(/no digas que eres una IA|Jamás digas que eres una IA/i);
    expect(prompt).toMatch(/venta cruzada/i);
    expect(prompt).toMatch(/CIERRA|cierre/i);
  });

  it('usa el nombre configurado del bot cuando se entrega', () => {
    const prompt = buildSellerSystemPrompt({ ...base, assistantName: 'Andrea' });
    expect(prompt).toContain('Andrea');
    // Ya no se presenta como "Place" si tiene nombre propio.
    expect(prompt).not.toMatch(/Eres Place,/);
  });

  it('un nombre en blanco cae al default Place', () => {
    const prompt = buildSellerSystemPrompt({ ...base, assistantName: '   ' });
    expect(prompt).toContain('Place');
  });

  it('personalidad "amable_profesional" (default) habla de calidez', () => {
    const prompt = buildSellerSystemPrompt(base);
    expect(prompt).toMatch(/Amable y Profesional/i);
    expect(prompt).toMatch(/cálido/i);
  });

  it('personalidad "directo_comercial" va al grano y pide mensajes cortos', () => {
    const prompt = buildSellerSystemPrompt({ ...base, personality: 'directo_comercial' });
    expect(prompt).toMatch(/Directo y Comercial/i);
    expect(prompt).toMatch(/al grano|mensajes cortos/i);
    expect(prompt).not.toMatch(/Amable y Profesional/i);
  });

  it('personalidad "formal_corporativo" exige trato de usted y sin emojis', () => {
    const prompt = buildSellerSystemPrompt({ ...base, personality: 'formal_corporativo' });
    expect(prompt).toMatch(/Formal y Corporativo/i);
    expect(prompt).toMatch(/usted/i);
    expect(prompt).toMatch(/No uses\s+emojis|sin emojis/i);
  });
});
