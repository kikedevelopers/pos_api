import type { GeminiFunctionDeclaration } from '@/modules/ai/internal/gemini.types';

/**
 * Herramientas que Place-vendedor puede usar. TODAS se ejecutan acotadas al
 * negocio del bot (`company_id` fijo de la config), nunca a datos de otro.
 *
 * Son de solo lectura del INVENTARIO (sin costos ni márgenes: el vendedor no ve
 * ni expone esa información), salvo las del PEDIDO EN CURSO (`set_cart_item`, `set_order_details`,
 * `close_order`), que solo escriben el carrito de la conversación. Cerrar le
 * AVISA al dueño: no crea venta ni pedido en el POS.
 */
export const SELLER_TOOL_NAMES = [
  'search_products',
  'find_products_for_need',
  'get_popular_products',
  'set_cart_item',
  'set_order_details',
  'close_order',
  'modify_last_order',
  'cancel_last_order',
] as const;

export type SellerToolName = (typeof SELLER_TOOL_NAMES)[number];

export const SELLER_TOOLS: readonly GeminiFunctionDeclaration[] = [
  {
    name: 'search_products',
    description:
      'Busca productos del inventario del negocio por nombre, CATEGORÍA (p. ej. "productos venezolanos", "lácteos"), código SKU o código de barras. Devuelve, por cada producto: nombre, categoría, presentación/empaque, existencias disponibles (stock) y los PRECIOS DE VENTA por nivel. NO devuelve costos. Úsala SIEMPRE antes de afirmar precio, existencia o presentación de cualquier producto. Si el cliente nombra algo de forma coloquial o con marca, usa varias búsquedas o términos alternativos.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description:
            'Texto a buscar en nombre, categoría, SKU o código de barras (tolera tildes y mayúsculas). Para una línea u origen usa la palabra clave de la categoría (ej. "venezolan").',
        },
        limit: {
          type: 'integer',
          description: 'Máximo de resultados (1-25). Por defecto 10.',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'find_products_for_need',
    description:
      'Busca por SIGNIFICADO los productos que resuelven una necesidad o un uso que describe el cliente ("algo para servir hamburguesa con papas", "qué me sirve para un asado", "necesito empacar comida para domicilio"), aunque no diga el nombre del producto. Devuelve las familias más parecidas con sus presentaciones, precios y su ficha (descripción, para qué sirve, características y relacionados). Para un producto que el cliente nombra, usa search_products.',
    parameters: {
      type: 'object',
      properties: {
        need: {
          type: 'string',
          description:
            'La necesidad COMPLETA del cliente en sus palabras, sumando lo que ya dijo antes (ej. "contenedor para hamburguesa y papas para domicilio").',
        },
        limit: { type: 'integer', description: 'Máximo de productos (1-10). Por defecto 5.' },
      },
      required: ['need'],
    },
  },
  {
    name: 'get_popular_products',
    description:
      'Lista productos destacados/populares del negocio con sus precios de venta y existencias, para recomendar o hacer venta cruzada cuando el cliente no sabe qué llevar o pide sugerencias. NO devuelve costos.',
    parameters: {
      type: 'object',
      properties: {
        limit: {
          type: 'integer',
          description: 'Cuántos productos sugerir (1-15). Por defecto 8.',
        },
      },
    },
  },
  {
    name: 'set_cart_item',
    description:
      'Pone en el PEDIDO EN CURSO la cantidad de una presentación (crea, corrige o, con quantity 0, quita la línea). Úsala en cuanto el cliente diga que lleva algo ("dame 2", "agrégame la libra"). Elige la presentación que corresponde EXACTAMENTE a lo que pidió: "media libra de clavo" = la presentación MEDIA LIBRA con quantity 1; "un cuarto" = la presentación CUARTO con quantity 1; "2000 de pimienta" (pedido POR VALOR) = el "id" de cualquier presentación de pimienta + amount_requested 2000: el negocio elige la presentación y la cantidad. El precio lo pone el negocio: no lo envíes. Devuelve el pedido actualizado, su total y "missing_to_close" (lo que falta para cerrar).',
    parameters: {
      type: 'object',
      properties: {
        product_id: {
          type: 'integer',
          description: 'El "id" de la presentación tal como lo devolvió search_products.',
        },
        quantity: {
          type: 'integer',
          description:
            'UNIDADES ENTERAS de esa presentación en el pedido (TOTAL, no la suma). La presentación ya trae su medida: media libra = 1 de la presentación MEDIA LIBRA, nunca 0.5. 0 = quitarla.',
        },
        amount_requested: {
          type: 'integer',
          description:
            'SOLO si el cliente pidió POR VALOR ("2000 de pimienta", "dame 5000 de comino"): el valor TOTAL en pesos (2000). Envía el "id" de cualquier presentación de ESE producto (molida ≠ en pepa) y el negocio elige: 1) la presentación de ese precio exacto; 2) si no hay, gramos sin pasarse; 3) si no, unidades fijas que sumen exacto. quantity se ignora. Si pidió por presentación o cantidad ("2 paquetes de mil"), NO lo envíes.',
        },
      },
      required: ['product_id'],
    },
  },
  {
    name: 'set_order_details',
    description:
      'Guarda los datos de entrega que el cliente vaya dando (aunque sea uno solo). Llámala en cuanto te dé cualquiera de ellos.',
    parameters: {
      type: 'object',
      properties: {
        customer_name: { type: 'string', description: 'Nombre de quien recibe.' },
        customer_phone: { type: 'string', description: 'Teléfono de contacto, si lo dio.' },
        delivery_mode: {
          type: 'string',
          enum: ['domicilio', 'recoger'],
          description:
            'domicilio = se lo llevan; recoger = pasa por el negocio. SOLO entre las entregas que ofrece el negocio (ver "Datos del negocio"); si ofrece una sola, no hace falta.',
        },
        delivery_address: {
          type: 'string',
          description:
            'Dirección de entrega con barrio/referencias, tal como la dio. Solo si el pedido es a domicilio.',
        },
        payment_method: {
          type: 'string',
          description: 'Cómo va a pagar, SOLO entre las formas de pago que acepta el negocio.',
        },
        notes: { type: 'string', description: 'Indicaciones del pedido (horario, cambio, etc.).' },
      },
    },
  },
  {
    name: 'close_order',
    description:
      'Cierra el pedido en curso y se lo envía al negocio. Llámala SOLO cuando el cliente confirmó explícitamente el resumen (productos y total) y ya no falta ningún dato. UNA vez por pedido. Si falta algo o cambió un precio, te lo dice y NO cierra.',
  },
  {
    name: 'modify_last_order',
    description:
      'El cliente quiere CAMBIAR el pedido que YA hizo en esta conversación (quitar o agregar productos, cambiar cantidades, entrega o pago). Si nadie lo ha tomado todavía, lo devuelve al carrito para que lo ajustes y, con su "sí", close_order ACTUALIZA ese mismo pedido (misma referencia). Si el equipo ya lo tomó, NO lo cambia: te dice qué responderle y deja la solicitud al equipo. NUNCA armes un pedido nuevo para cambiar el anterior.',
    parameters: {
      type: 'object',
      properties: {
        request: {
          type: 'string',
          description: 'Lo que el cliente pidió cambiar, en sus palabras (ej. "quitar la nuez").',
        },
      },
      required: ['request'],
    },
  },
  {
    name: 'cancel_last_order',
    description:
      'El cliente quiere CANCELAR el pedido que YA hizo en esta conversación (ya no lo quiere). Si nadie lo ha tomado, queda cancelado por el cliente. Si el equipo ya lo tomó, NO lo cancela: te dice qué responderle y deja la solicitud al equipo. Confirma con el cliente antes de llamarla.',
    parameters: {
      type: 'object',
      properties: {
        reason: {
          type: 'string',
          description: 'Por qué lo cancela, si lo dijo.',
        },
      },
    },
  },
] as const;
