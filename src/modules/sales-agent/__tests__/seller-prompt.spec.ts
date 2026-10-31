import {
  buildBusinessInfoBlock,
  buildCategoriesBlock,
  buildOwnerStyleBlock,
  MAX_PROMPT_CATEGORIES,
  buildPaymentBlock,
  buildSellerSystemPrompt,
  SELLER_ASSISTANT_NAME,
} from '../internal/seller-prompt';

describe('buildSellerSystemPrompt', () => {
  it('después de cerrar: cambiar o cancelar el MISMO pedido, nunca uno nuevo', () => {
    const prompt = buildSellerSystemPrompt(base);
    expect(prompt).toContain('# Después de cerrar: cambios y cancelaciones');
    expect(prompt).toContain('usa modify_last_order. NUNCA armes');
    expect(prompt).toContain('cancel_last_order');
    expect(prompt).toContain('equipo de\n  despacho');
  });

  it('precisión del pedido: unidades enteras de la presentación y pedido por valor exacto', () => {
    const prompt = buildSellerSystemPrompt(base);
    expect(prompt).toContain('PRECISIÓN DEL PEDIDO');
    expect(prompt).toContain(
      '"media libra de clavo" = 1 de la presentación MEDIA LIBRA (nunca 0.5',
    );
    expect(prompt).toContain('PEDIDO POR VALOR');
    expect(prompt).toContain('primero la\n    presentación de ese precio exacto');
    expect(prompt).toContain('"2 paquetes de mil" NO es por valor');
    expect(prompt).toContain('cita las cantidades y los totales del pedido en');
  });

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

  it('sin dirección NO inventa una ubicación (ni asume domicilio si el negocio no lo hace)', () => {
    const block = buildBusinessInfoBlock({
      businessName: 'Esencia & Grano',
      address: '   ',
      delivery: { pickupAvailable: true, deliveryAvailable: false, pickupAddress: null },
    });
    expect(block).toMatch(/NO tiene una dirección registrada/);
    expect(block).toMatch(/NO inventes una ubicación/);
    expect(block).toMatch(/SOLO se RECOGEN en el negocio/);
    expect(block).toMatch(/no hay una dirección registrada: si preguntan dónde, NO inventes/);
    expect(block).not.toMatch(/pídele la dirección/);
  });

  it('solo recoger: prohíbe ofrecer envío y pedir dirección', () => {
    const block = buildBusinessInfoBlock({
      businessName: 'X',
      address: 'Cra 10 #20-30',
      delivery: {
        pickupAvailable: true,
        deliveryAvailable: false,
        pickupAddress: 'Local 3, Centro',
      },
    });
    expect(block).toMatch(/SOLO se RECOGEN en Local 3, Centro/);
    expect(block).toMatch(
      /NO hace\s+envíos a domicilio: nunca ofrezcas envío ni pidas una dirección/,
    );
  });

  it('solo domicilio: pide la dirección y no ofrece recogida', () => {
    const block = buildBusinessInfoBlock({
      businessName: 'X',
      address: 'Cra 10',
      delivery: { pickupAvailable: false, deliveryAvailable: true },
    });
    expect(block).toMatch(/SOLO con ENVÍO A DOMICILIO/);
    expect(block).toMatch(/Pídele la dirección de entrega/);
    expect(block).not.toMatch(/RECOGER su pedido/);
  });

  it('ambas: pregunta cuál prefiere', () => {
    const block = buildBusinessInfoBlock({
      businessName: 'X',
      delivery: { pickupAvailable: true, deliveryAvailable: true, pickupAddress: 'Calle 1' },
    });
    expect(block).toMatch(/RECOGER su pedido en Calle 1 o pedir ENVÍO A\s+DOMICILIO/);
    expect(block).toMatch(/Pregúntale cuál prefiere/);
  });

  it('sin ajuste de entregas (clientes viejos): recoge solo si hay dirección', () => {
    expect(buildBusinessInfoBlock({ businessName: 'X', address: 'Calle 1' })).toMatch(
      /RECOGER su pedido en Calle 1 o pedir ENVÍO/,
    );
    expect(buildBusinessInfoBlock({ businessName: 'X' })).toMatch(/SOLO con ENVÍO A DOMICILIO/);
  });

  it('por WhatsApp: los pedidos van por este mismo chat', () => {
    const block = buildBusinessInfoBlock({
      businessName: 'X',
      phone: '3001234567',
      channel: 'whatsapp',
    });
    expect(block).toMatch(/por este mismo chat de WhatsApp/);
  });

  it('por Telegram con teléfono: también por WhatsApp a ese número', () => {
    const block = buildBusinessInfoBlock({
      businessName: 'X',
      phone: '3001234567',
      channel: 'telegram',
    });
    expect(block).toMatch(/por WhatsApp al 3001234567/);
  });

  it('sin teléfono por Telegram: por este chat', () => {
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

describe('Búsqueda por necesidad', () => {
  const prompt = buildSellerSystemPrompt({ businessName: 'X', today: '2026-10-30' });

  it('usa find_products_for_need cuando el cliente describe un uso o necesidad', () => {
    expect(prompt).toMatch(/describe una NECESIDAD o un uso/);
    expect(prompt).toMatch(/find_products_for_need con la necesidad completa/);
  });

  it('ante un requisito nuevo vuelve a buscar con la necesidad completa y considera el upgrade', () => {
    expect(prompt).toMatch(/necesidad COMPLETA actualizada/);
    expect(prompt).toMatch(/relacionado "upgrade"/);
  });
});

describe('Formas de pago', () => {
  const base = { businessName: 'Granero La 21', today: '2026-10-29' };

  it('sin configurar: efectivo y transferencia (comportamiento anterior)', () => {
    const block = buildPaymentBlock({});
    expect(block).toContain('ÚNICAMENTE: efectivo y transferencia o consignación bancaria');
    expect(block).toMatch(
      /tarjeta débito y tarjeta de crédito, dile con amabilidad que\s+por ahora no la manejan/,
    );
  });

  it('solo ofrece las formas que acepta el negocio', () => {
    const block = buildPaymentBlock({ methods: ['cash', 'debit_card', 'credit_card'] });
    expect(block).toContain('ÚNICAMENTE: efectivo, tarjeta débito y tarjeta de crédito');
    expect(block).toContain('pagar con transferencia o consignación bancaria');
    expect(block).toMatch(/pregunta cómo va a pagar/);
  });

  it('con una sola forma de pago no la pregunta: la informa', () => {
    const block = buildPaymentBlock({ methods: ['bank_transfer'] });
    expect(block).toMatch(/NO le preguntes al cliente cómo va a pagar/);
    expect(block).toContain('el pago es en transferencia o consignación bancaria');
  });

  it('con todas las formas no menciona ninguna rechazada', () => {
    const block = buildPaymentBlock({
      methods: ['cash', 'bank_transfer', 'debit_card', 'credit_card'],
    });
    expect(block).not.toMatch(/no la manejan/);
  });

  it('ignora valores desconocidos y cae al default si no queda ninguno', () => {
    const block = buildPaymentBlock({ methods: ['bitcoin' as never] });
    expect(block).toContain('ÚNICAMENTE: efectivo y transferencia o consignación bancaria');
  });

  it('comparte las indicaciones de pago tal cual', () => {
    const block = buildPaymentBlock({
      methods: ['bank_transfer'],
      instructions: ' Nequi 300 123 4567 ',
    });
    expect(block).toContain('«Nequi 300 123 4567»');
    expect(block).not.toMatch(/Nunca los inventes/);
  });

  it('sin indicaciones prohíbe inventar cuentas', () => {
    expect(buildPaymentBlock({})).toMatch(/Nunca los inventes/);
  });

  it('el prompt incluye el bloque y el cierre pide el pago según esas formas', () => {
    const prompt = buildSellerSystemPrompt({ ...base, paymentMethods: ['credit_card'] });
    expect(prompt).toContain('# Formas de pago');
    expect(prompt).toContain('ÚNICAMENTE: tarjeta de crédito');
    expect(prompt).toContain('la forma de pago según "Formas de pago"');
  });
});

describe('Estilo propio del dueño', () => {
  const base = { businessName: 'Granero La 21', today: '2026-10-29' };

  it('sin indicaciones no agrega la sección', () => {
    expect(buildOwnerStyleBlock()).toBeNull();
    expect(buildOwnerStyleBlock({ greeting: '  ', selling: '', closing: undefined })).toBeNull();
    expect(buildSellerSystemPrompt(base)).not.toContain('Estilo propio del negocio');
  });

  it('incluye solo las etapas definidas', () => {
    const block = buildOwnerStyleBlock({ selling: 'Recomienda lo de la casa' }) ?? '';
    expect(block).toContain('- Al asesorar y vender: «Recomienda lo de la casa»');
    expect(block).not.toContain('Al saludar');
    expect(block).not.toContain('Al cerrar la venta');
  });

  it('las reglas de oro siguen mandando sobre el estilo del dueño', () => {
    const block = buildOwnerStyleBlock({ closing: 'Ofrece 50% de descuento' }) ?? '';
    expect(block).toMatch(/NUNCA sobre las Reglas de oro/);
    expect(block).toMatch(/gana la regla/);
  });

  it('colapsa saltos de línea y neutraliza las comillas de cita', () => {
    const block = buildOwnerStyleBlock({ greeting: 'Hola\n\n«vecino»' }) ?? '';
    expect(block).toContain('- Al saludar: «Hola "vecino"»');
  });

  it('el prompt ubica el estilo después de la personalidad', () => {
    const prompt = buildSellerSystemPrompt({
      ...base,
      ownerStyle: {
        greeting: 'Saluda con ¡Hola, vecino!',
        closing: 'Recuerda el domicilio gratis',
      },
    });
    const personality = prompt.indexOf('# Tu personalidad');
    const style = prompt.indexOf('# Estilo propio del negocio');
    expect(personality).toBeGreaterThan(-1);
    expect(style).toBeGreaterThan(personality);
    expect(prompt).toContain('- Al cerrar la venta: «Recuerda el domicilio gratis»');
  });

  it('con saludo propio, el ejemplo del preset queda solo de referencia', () => {
    const prompt = buildSellerSystemPrompt({
      ...base,
      firstMessageOfDay: true,
      ownerStyle: { greeting: 'Saluda con ¡Hola, vecino!' },
    });
    expect(prompt).toMatch(/Saluda como lo pidió el dueño/);
    expect(prompt).not.toMatch(/Ejemplo de tono:/);
  });

  it('sin saludo propio conserva el ejemplo de tono del preset', () => {
    const prompt = buildSellerSystemPrompt({
      ...base,
      firstMessageOfDay: true,
      ownerStyle: { selling: 'Lo de la casa' },
    });
    expect(prompt).toMatch(/Ejemplo de tono:/);
    expect(prompt).not.toMatch(/Saluda como lo pidió el dueño/);
  });
});

describe('Categorías del catálogo', () => {
  const base = { businessName: 'Esencia & Grano', today: '2026-10-30' };

  it('sin categorías no agrega el bloque', () => {
    expect(buildCategoriesBlock()).toBeNull();
    expect(buildCategoriesBlock(['  ', ''])).toBeNull();
    expect(buildSellerSystemPrompt(base)).not.toContain('# Categorías de tu catálogo');
  });

  it('lista las categorías y pide buscar por la categoría cuando preguntan por una línea u origen', () => {
    const block = buildCategoriesBlock(['Especias', 'Productos Venezolanos']) ?? '';
    expect(block).toContain('estas categorías: Especias, Productos Venezolanos.');
    expect(block).toMatch(/venden productos\s+venezolanos/);
    expect(block).toMatch(/search_products usando su palabra clave/);
  });

  it('quita duplicados y respeta el tope', () => {
    const many = Array.from({ length: MAX_PROMPT_CATEGORIES + 5 }, (_, i) => `Cat ${i}`);
    const block = buildCategoriesBlock(['Lácteos', 'Lácteos', ...many]) ?? '';
    expect(block.match(/Lácteos/g)).toHaveLength(1);
    expect(block).not.toContain(`Cat ${MAX_PROMPT_CATEGORIES}`);
  });

  it('el prompt incluye el bloque cuando hay categorías', () => {
    const prompt = buildSellerSystemPrompt({
      ...base,
      catalogCategories: ['Productos Venezolanos'],
    });
    expect(prompt).toContain('# Categorías de tu catálogo');
    expect(prompt).toContain('Productos Venezolanos');
  });

  it('regla de oro: nunca dice que no vende algo sin buscarlo (nombre y categoría)', () => {
    const prompt = buildSellerSystemPrompt(base);
    expect(prompt).toMatch(/NUNCA respondas que no venden algo sin haberlo buscado/);
    expect(prompt).toMatch(/por la categoría/);
  });
});
