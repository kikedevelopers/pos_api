import {
  buildBusinessInfoBlock,
  buildSellerSystemPrompt,
  SELLER_ASSISTANT_NAME,
} from '../internal/seller-prompt';

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
    expect(prompt).toMatch(/close_order UNA sola vez/i);
    expect(prompt).toMatch(/registrado en el\s+sistema/i);
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

  it('sin dato de primer mensaje no agrega la sección de saludo', () => {
    const prompt = buildSellerSystemPrompt(base);
    expect(prompt).not.toMatch(/# Saludo/);
  });

  it('primer mensaje del día: pide saludar según la hora y presentarse', () => {
    const prompt = buildSellerSystemPrompt({
      ...base,
      assistantName: 'Diana',
      firstMessageOfDay: true,
      timeOfDay: 'tarde',
    });
    expect(prompt).toMatch(/primer mensaje del cliente HOY/i);
    expect(prompt).toMatch(/PRESÉNTATE/);
    expect(prompt).toContain('buenas tardes');
    // Ejemplo de tono con el nombre y el negocio.
    expect(prompt).toContain('Soy Diana, de Granero La 21');
  });

  it('el ejemplo de saludo sigue la personalidad elegida', () => {
    const formal = buildSellerSystemPrompt({
      ...base,
      assistantName: 'Diana',
      personality: 'formal_corporativo',
      firstMessageOfDay: true,
      timeOfDay: 'manana',
    });
    expect(formal).toContain('Le saluda Diana, de Granero La 21. ¿En qué puedo servirle?');

    const directo = buildSellerSystemPrompt({
      ...base,
      assistantName: 'Diana',
      personality: 'directo_comercial',
      firstMessageOfDay: true,
      timeOfDay: 'noche',
    });
    expect(directo).toContain('Buenas noches, soy Diana de Granero La 21. ¿Qué necesitas?');
  });

  it('si ya saludó hoy, prohíbe presentarse otra vez', () => {
    const prompt = buildSellerSystemPrompt({ ...base, firstMessageOfDay: false });
    expect(prompt).toMatch(/Ya saludaste a este cliente hoy/);
    expect(prompt).toMatch(/NO te vuelvas a presentar/);
    expect(prompt).not.toMatch(/PRESÉNTATE/);
  });

  it('personalidad "formal_corporativo" exige trato de usted y sin emojis', () => {
    const prompt = buildSellerSystemPrompt({ ...base, personality: 'formal_corporativo' });
    expect(prompt).toMatch(/Formal y Corporativo/i);
    expect(prompt).toMatch(/usted/i);
    expect(prompt).toMatch(/No uses\s+emojis|sin emojis/i);
  });
});

describe('buildSellerSystemPrompt · política de stock', () => {
  const base = { businessName: 'Granero La 21', today: '2026-10-30' };

  it('inform (default): avisa cuando algo está agotado', () => {
    const prompt = buildSellerSystemPrompt(base);
    expect(prompt).toMatch(/aclara que ahora no hay existencia/);
    expect(prompt).not.toMatch(/NUNCA hables de\s+existencias/);
  });

  it('offer_always: vende todo y prohíbe hablar de existencias', () => {
    const prompt = buildSellerSystemPrompt({ ...base, stockPolicy: 'offer_always' });
    expect(prompt).toMatch(/NUNCA hables de\s+existencias/);
    expect(prompt).toMatch(/Ofrece y\s+vende TODOS los productos/);
    expect(prompt).not.toMatch(/aclara que ahora no hay existencia/);
    expect(prompt).not.toMatch(/si algo no hay, ofrece la alternativa/);
    // Sigue exigiendo dar el precio de inmediato.
    expect(prompt).toMatch(/DÁLO de inmediato/);
  });
});

describe('Datos del negocio en el prompt', () => {
  const base = { businessName: 'Esencia & Grano', today: '2026-10-30' };

  it('con dirección, la entrega tal cual para que el cliente llegue', () => {
    const prompt = buildSellerSystemPrompt({ ...base, businessAddress: 'Cra 10 #20-30' });
    expect(prompt).toContain('# Datos del negocio');
    expect(prompt).toContain('Cra 10 #20-30');
    expect(prompt).not.toMatch(/NO tiene una dirección/);
  });

  it('sin dirección NO inventa: orienta al pedido con envío a domicilio', () => {
    const block = buildBusinessInfoBlock({ businessName: 'Esencia & Grano', address: '   ' });
    expect(block).toMatch(/NO tiene una dirección/);
    expect(block).toMatch(/NO inventes una ubicación/);
    expect(block).toMatch(/envío a domicilio/);
  });

  it('sin dirección por WhatsApp: invita a pedir por este mismo chat', () => {
    const block = buildBusinessInfoBlock({
      businessName: 'X',
      address: null,
      phone: '3001234567',
      channel: 'whatsapp',
    });
    expect(block).toMatch(/este mismo chat de WhatsApp/);
  });

  it('sin dirección por Telegram con teléfono: invita a pedir por WhatsApp a ese número', () => {
    const block = buildBusinessInfoBlock({
      businessName: 'X',
      address: null,
      phone: '3001234567',
      channel: 'telegram',
    });
    expect(block).toMatch(/por WhatsApp al 3001234567/);
  });

  it('sin dirección ni teléfono por Telegram: invita a pedir por este chat', () => {
    const block = buildBusinessInfoBlock({ businessName: 'X', channel: 'telegram' });
    expect(block).toMatch(/por este mismo chat\./);
    expect(block).not.toMatch(/Teléfono del negocio/);
  });

  it('incluye el teléfono cuando existe', () => {
    const block = buildBusinessInfoBlock({
      businessName: 'X',
      address: 'Calle 1',
      phone: '601 555',
    });
    expect(block).toContain('Teléfono del negocio: 601 555');
  });

  it('prohíbe inventar datos del negocio (horarios, dueños, redes)', () => {
    const block = buildBusinessInfoBlock({ businessName: 'X', address: 'Calle 1' });
    expect(block).toMatch(/Nunca inventes dirección/);
    expect(block).toMatch(/nombres de dueños/);
  });
});

describe('Productos: nombres naturales y presentaciones', () => {
  const prompt = buildSellerSystemPrompt({ businessName: 'X', today: '2026-10-30' });

  it('pide no copiar el nombre del catálogo literal', () => {
    expect(prompt).toMatch(/NO copies el nombre del catálogo tal cual/);
    expect(prompt).toMatch(/Si el precio ya va en el nombre, no lo repitas/);
  });

  it('pide ofrecer las presentaciones disponibles en vez de escoger una', () => {
    expect(prompt).toMatch(/ofrécele las presentaciones de consumo/);
    expect(prompt).toMatch(/No\s+escojas una sola/);
  });
});

describe('Saludo: no repetir', () => {
  it('aun en el primer mensaje del día, no repite si el historial ya tiene el saludo', () => {
    const prompt = buildSellerSystemPrompt({
      businessName: 'X',
      today: '2026-10-30',
      firstMessageOfDay: true,
    });
    expect(prompt).toMatch(/ya saludaste o te presentaste, NO lo\s+repitas/);
  });
});

describe('Cierre de ventas sin atosigar', () => {
  const prompt = buildSellerSystemPrompt({ businessName: 'X', today: '2026-10-30' });

  it('orienta a cerrar: un solo paso concreto por respuesta y cierre asumido', () => {
    expect(prompt).toMatch(/tu objetivo es CERRAR la venta/);
    expect(prompt).toMatch(/UN solo paso concreto hacia el cierre/);
    expect(prompt).toMatch(/cierre asumido/);
  });

  it('arma el pedido con las herramientas (id + cantidad total) y pide el "sí" antes de cerrar', () => {
    expect(prompt).toMatch(/set_cart_item con el "id"/);
    expect(prompt).toMatch(/set_order_details/);
    expect(prompt).toMatch(/Con el "sí" explícito llama close_order/);
  });

  it('limita la venta cruzada y no insiste ante la duda', () => {
    expect(prompt).toMatch(/como máximo UNA sugerencia por mensaje/);
    expect(prompt).toMatch(/no la vuelvas a ofrecer/);
    expect(prompt).toMatch(/UNA sola pregunta para entender qué\s+lo frena/);
  });

  it('incluye el bloque del pedido en curso cuando se le pasa', () => {
    const withCart = buildSellerSystemPrompt({
      businessName: 'X',
      today: '2026-10-30',
      cartBlock: '# Pedido en curso\n- 2 × ARROZ',
    });
    expect(withCart).toContain('# Pedido en curso\n- 2 × ARROZ');
    expect(prompt).not.toContain('# Pedido en curso');
  });
});
