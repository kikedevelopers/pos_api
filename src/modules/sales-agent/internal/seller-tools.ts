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
  'get_popular_products',
  'set_cart_item',
  'set_order_details',
  'close_order',
] as const;

export type SellerToolName = (typeof SELLER_TOOL_NAMES)[number];

export const SELLER_TOOLS: readonly GeminiFunctionDeclaration[] = [
  {
    name: 'search_products',
    description:
      'Busca productos del inventario del negocio por nombre, código SKU o código de barras. Devuelve, por cada producto: nombre, categoría, presentación/empaque, existencias disponibles (stock) y los PRECIOS DE VENTA por nivel. NO devuelve costos. Úsala SIEMPRE antes de afirmar precio, existencia o presentación de cualquier producto. Si el cliente nombra algo de forma coloquial o con marca, usa varias búsquedas o términos alternativos.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description:
            'Texto a buscar en nombre, SKU o código de barras (tolera tildes y mayúsculas).',
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
      'Pone en el PEDIDO EN CURSO la cantidad de una presentación (crea, corrige o, con quantity 0, quita la línea). Úsala en cuanto el cliente diga que lleva algo ("dame 2", "agrégame la libra"). El precio lo pone el negocio: no lo envíes. Devuelve el pedido actualizado, su total y "missing_to_close" (lo que falta para cerrar).',
    parameters: {
      type: 'object',
      properties: {
        product_id: {
          type: 'integer',
          description: 'El "id" de la presentación tal como lo devolvió search_products.',
        },
        quantity: {
          type: 'number',
          description:
            'Cantidad TOTAL de esa presentación en el pedido (no la suma). 0 = quitarla.',
        },
      },
      required: ['product_id', 'quantity'],
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
          description: 'domicilio = se lo llevan; recoger = pasa por el negocio.',
        },
        delivery_address: {
          type: 'string',
          description: 'Dirección de entrega con barrio/referencias, tal como la dio.',
        },
        payment_method: {
          type: 'string',
          description: 'Cómo va a pagar (efectivo, transferencia...), si lo dijo.',
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
] as const;
