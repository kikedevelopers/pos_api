import type { GeminiFunctionDeclaration } from '@/modules/ai/internal/gemini.types';

/**
 * Herramientas que Place-vendedor puede usar. TODAS se ejecutan acotadas al
 * negocio del bot (`company_id` fijo de la config), nunca a datos de otro.
 *
 * Son de solo lectura del INVENTARIO (sin costos ni márgenes: el vendedor no ve
 * ni expone esa información), salvo `submit_order`, que no escribe en la base:
 * registra el pedido para avisarle al dueño (la creación real en el POS llega
 * en una iteración posterior).
 */
export const SELLER_TOOL_NAMES = [
  'search_products',
  'get_popular_products',
  'submit_order',
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
    name: 'submit_order',
    description:
      'Registra el pedido que el cliente YA confirmó, para avisarle al dueño del negocio. Llámala solo cuando el cliente aceptó explícitamente lo que lleva. Incluye TODAS las líneas con el nombre EXACTO del producto como te lo devolvió search_products, su cantidad y su precio unitario de venta. Incluye los datos de contacto/entrega que te dio el cliente. Tras registrarla, confírmale al cliente con un resumen cálido.',
    parameters: {
      type: 'object',
      properties: {
        items: {
          type: 'array',
          description: 'Líneas del pedido confirmadas por el cliente.',
          items: {
            type: 'object',
            properties: {
              name: {
                type: 'string',
                description:
                  'Nombre EXACTO del producto tal como lo devolvió search_products (con su presentación).',
              },
              quantity: {
                type: 'number',
                description: 'Cantidad de ese producto/presentación, como número limpio.',
              },
              unit_price: {
                type: 'number',
                description: 'Precio UNITARIO de venta en pesos, sin separadores (ej. 12000).',
              },
            },
            required: ['name', 'quantity', 'unit_price'],
          },
        },
        customer_name: {
          type: 'string',
          description: 'Nombre del cliente, si lo dio.',
        },
        customer_phone: {
          type: 'string',
          description: 'Teléfono del cliente, si lo dio.',
        },
        delivery: {
          type: 'string',
          description:
            'Dirección o indicación de entrega/recogida tal como la dio el cliente, si aplica.',
        },
        notes: {
          type: 'string',
          description: 'Cualquier nota relevante del pedido (forma de pago, horario, etc.).',
        },
      },
      required: ['items'],
    },
  },
] as const;
