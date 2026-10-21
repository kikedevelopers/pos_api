import type { PermissionKey } from '@/modules/roles/internal/permission-catalog';

import {
  hasMultipleBusinesses,
  withBusinessIdParam,
  type AiBusinessScopeActor,
} from './business-scope';
import type { GeminiFunctionDeclaration } from './gemini.types';

/**
 * Catálogo de herramientas que PlacePOS IA puede ejecutar contra la base de
 * datos del negocio. Todas se filtran por `company_id` en su implementación
 * (`run-ai-tool.action.ts`). Son de solo lectura, SALVO las de gastos
 * (`register_expense`, `void_expense`, `confirm_expense_action`) y las de
 * pedidos (`prepare_sale`, `confirm_sale`), que exigen además ser
 * administrador (`requires_administrator`), y las de tesorería
 * (`prepare_treasury_transfer`, `prepare_balance_correction`,
 * `confirm_treasury_action`), solo del dueño (`requires_owner`). Ninguna
 * escribe sin la confirmación explícita del usuario en un mensaje posterior.
 *
 * Cada herramienta declara el permiso del catálogo que exige. Si el actor no lo
 * tiene, la herramienta ni siquiera se le ofrece al modelo (no puede llamarla) y
 * además se rechaza en ejecución — defensa en profundidad: el modelo podría
 * alucinar un nombre de función que no le declaramos.
 */

export const AI_TOOL_NAMES = [
  'get_daily_summary',
  'list_sales',
  'get_performance_range',
  'get_top_products',
  'search_products',
  'get_low_stock',
  'get_debtors',
  'search_customers',
  'search_suppliers',
  'get_expenses_summary',
  'get_treasury_accounts',
  'get_businesses_overview',
  'register_expense',
  'void_expense',
  'confirm_expense_action',
  'prepare_sale',
  'confirm_sale',
  'prepare_treasury_transfer',
  'prepare_balance_correction',
  'confirm_treasury_action',
] as const;

export type AiToolName = (typeof AI_TOOL_NAMES)[number];

export interface AiToolDefinition {
  name: AiToolName;
  /** Etiqueta que el cliente muestra mientras la herramienta corre. */
  label: string;
  /**
   * Una línea en el idioma del comerciante para la lista de "qué puedo
   * consultar". La `description` de la declaración es para el modelo; esta es
   * para la persona.
   */
  summary: string;
  /** Permiso exigido. `null` = disponible para cualquier usuario autenticado. */
  permission: PermissionKey | null;
  /** true si el resultado contiene costos/ganancias/márgenes. */
  exposesProfit: boolean;
  /**
   * Herramienta que ESCRIBE: solo el owner/superadmin o un empleado con el rol
   * de fábrica "Administrador". Se suma al `permission`, no lo reemplaza.
   */
  requires_administrator?: boolean;
  /**
   * Herramienta que ESCRIBE y que solo puede usar el owner/superadmin — ni el
   * rol Administrador: espejo de "Mover saldo"/"Corregir caja", que la API ya
   * restringe al dueño.
   */
  requires_owner?: boolean;
  /**
   * Solo para el OWNER con sucursales (consolidado de todos sus negocios). A
   * cualquier otro usuario ni se le declara.
   */
  requires_branches?: boolean;
  /** false = no se lista en "qué puede hacer Place" (es un paso interno). */
  is_listed?: boolean;
  declaration: GeminiFunctionDeclaration;
}

const dateParam = (description: string): Record<string, unknown> => ({
  type: 'string',
  description: `${description} Formato YYYY-MM-DD (zona horaria de Colombia).`,
});

export const AI_TOOLS: readonly AiToolDefinition[] = [
  {
    name: 'get_daily_summary',
    label: 'Resumen del día',
    summary: 'Cómo va el día: recaudo, ventas, ganancia, gastos y saldos de caja.',
    permission: 'canAccessDashboard',
    exposesProfit: true,
    declaration: {
      name: 'get_daily_summary',
      description:
        'Resumen financiero de un día: ventas en efectivo, consignaciones, abonos a créditos, total recaudado, ventas totales (incluye créditos), ganancia, excedente de reinversión, gastos, ganancia real, número de ventas, créditos generados, compras y saldos de las cajas. Úsala para "¿cómo vamos hoy?", cierres de caja y comparaciones de un día concreto.',
      parameters: {
        type: 'object',
        properties: {
          date: dateParam('Día a consultar. Si se omite, hoy.'),
        },
      },
    },
  },
  {
    name: 'list_sales',
    label: 'Ventas del día',
    summary: 'Las ventas una por una: ticket, hora, cliente, productos y forma de pago.',
    permission: 'canAccessSalesReport',
    exposesProfit: true,
    declaration: {
      name: 'list_sales',
      description:
        'Lista las ventas de un día una por una, con su número de ticket, hora, CLIENTE (o "Mostrador" si fue venta de contado sin cliente), método de pago, total, saldo pendiente si fue a crédito, cajero que la registró y el DETALLE DE PRODUCTOS de cada ticket. Úsala siempre que pregunten "qué vendí", "a quién le vendí", "qué productos salieron hoy" o pidan el detalle de una venta concreta; get_daily_summary solo da los totales.',
      parameters: {
        type: 'object',
        properties: {
          date: dateParam('Día a listar. Si se omite, hoy.'),
          limit: {
            type: 'integer',
            description:
              'Máximo de ventas a devolver (1-50). Por defecto 20, de la más reciente a la más antigua.',
          },
          customer: {
            type: 'string',
            description:
              'Opcional: filtra por nombre del cliente (coincidencia parcial). Úsalo para "qué le vendí a Juan".',
          },
        },
      },
    },
  },
  {
    name: 'get_performance_range',
    label: 'Rendimiento del período',
    summary: 'Tendencia de un rango de fechas: ventas, ganancia, gastos y créditos, día por día.',
    permission: 'canAccessDashboard',
    exposesProfit: true,
    declaration: {
      name: 'get_performance_range',
      description:
        'Serie diaria y totales de ventas, ganancia, gastos y créditos generados en un rango de fechas. Úsala para tendencias, comparar semanas o meses y responder "¿cuánto vendimos del X al Y?".',
      parameters: {
        type: 'object',
        properties: {
          from: dateParam('Inicio del rango (inclusive).'),
          to: dateParam('Fin del rango (inclusive).'),
        },
        required: ['from', 'to'],
      },
    },
  },
  {
    name: 'get_top_products',
    label: 'Productos más vendidos',
    summary: 'Los productos que más se venden, con su ganancia y margen.',
    permission: 'canAccessDashboard',
    exposesProfit: true,
    declaration: {
      name: 'get_top_products',
      description:
        'Productos más vendidos por unidades netas (ya descontadas las notas crédito), con venta, costo, ganancia y margen promedio.',
      parameters: {
        type: 'object',
        properties: {
          limit: {
            type: 'integer',
            description: 'Cuántos productos devolver (1-50). Por defecto 10.',
          },
        },
      },
    },
  },
  {
    name: 'search_products',
    label: 'Búsqueda en inventario',
    summary: 'Cualquier producto del inventario: existencias, costo, precios y empaque.',
    permission: 'canAccessInventory',
    exposesProfit: true,
    declaration: {
      name: 'search_products',
      description:
        'Busca productos del inventario por nombre, código SKU o código de barras. Devuelve existencias, costo, precios de venta, categoría y empaque. Úsala antes de responder cualquier pregunta sobre un producto puntual.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Texto a buscar en nombre, SKU o código de barras.',
          },
          limit: {
            type: 'integer',
            description: 'Máximo de resultados (1-25). Por defecto 10.',
          },
        },
        required: ['query'],
      },
    },
  },
  {
    name: 'get_low_stock',
    label: 'Productos por agotarse',
    summary: 'Lo que está por agotarse, de lo más crítico a lo menos.',
    permission: 'canAccessInventory',
    exposesProfit: true,
    declaration: {
      name: 'get_low_stock',
      description:
        'Productos con existencias por debajo de un umbral, del más bajo al más alto. Úsala para alertas de reposición y sugerencias de compra.',
      parameters: {
        type: 'object',
        properties: {
          threshold: {
            type: 'number',
            description: 'Existencias máximas para considerar bajo stock. Por defecto 5.',
          },
          limit: {
            type: 'integer',
            description: 'Máximo de resultados (1-50). Por defecto 20.',
          },
        },
      },
    },
  },
  {
    name: 'get_debtors',
    label: 'Cartera de clientes',
    summary: 'La cartera: cuánto te deben y quiénes tienen la deuda más vieja.',
    permission: 'canAccessCreditsReport',
    exposesProfit: false,
    declaration: {
      name: 'get_debtors',
      description:
        'Cartera pendiente: total por cobrar y los clientes que más deben, con saldo, número de créditos y antigüedad de la deuda más vieja.',
      parameters: {
        type: 'object',
        properties: {
          limit: {
            type: 'integer',
            description: 'Cuántos deudores listar (1-50). Por defecto 10.',
          },
        },
      },
    },
  },
  {
    name: 'search_customers',
    label: 'Búsqueda de clientes',
    summary: 'Tus clientes: deuda, anticipos, puntos y su última compra.',
    permission: 'canAccessCustomers',
    exposesProfit: false,
    declaration: {
      name: 'search_customers',
      description:
        'Busca clientes por nombre, documento, teléfono o correo. Devuelve su saldo de deuda, anticipos, puntos y la fecha de su última compra.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Texto a buscar en nombre, documento, teléfono o correo.',
          },
          limit: {
            type: 'integer',
            description: 'Máximo de resultados (1-25). Por defecto 10.',
          },
        },
        required: ['query'],
      },
    },
  },
  {
    name: 'search_suppliers',
    label: 'Proveedores y compras',
    summary:
      'Tus proveedores: datos, cuánto les debes y el detalle de tus compras (pagadas y pendientes).',
    permission: 'canAccessSuppliers',
    exposesProfit: false,
    declaration: {
      name: 'search_suppliers',
      description:
        'Información completa de uno o varios proveedores y sus compras. Devuelve datos del proveedor (razón social, contacto/broker, teléfono, dirección, documento, correo y cuentas para consignarle), cuánto le debe el negocio HOY ("debt"), el saldo a favor, y el detalle de las compras: total comprado, total pagado, total pendiente, cuáles compras están pagas y cuáles aún se deben, y QUÉ se compró en cada una. Úsala para "¿cuánto le debo a X?", "¿qué le he comprado a Y?", "¿qué compras tengo pendientes de pagar con Z?" o cualquier dato de un proveedor. Si se omite "query" lista los proveedores ordenados por mayor deuda. INCLUYE proveedores archivados: si "isArchived" es true, avisa que el proveedor ya no está activo y aun así entrega la información.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description:
              'Opcional: nombre, documento, teléfono o correo del proveedor (coincidencia parcial, sin importar tildes). Si se omite, lista los proveedores con mayor deuda.',
          },
          limit: {
            type: 'integer',
            description: 'Máximo de proveedores a devolver (1-10). Por defecto 5.',
          },
        },
      },
    },
  },
  {
    name: 'get_expenses_summary',
    label: 'Gastos del período',
    summary: 'Los gastos de un período: total, fijos vs. variables y por categoría.',
    permission: 'canAccessExpenses',
    exposesProfit: false,
    declaration: {
      name: 'get_expenses_summary',
      description:
        'Gastos de un rango de fechas: total, desglose entre fijos y variables, agrupación por categoría y los gastos más grandes.',
      parameters: {
        type: 'object',
        properties: {
          from: dateParam('Inicio del rango (inclusive).'),
          to: dateParam('Fin del rango (inclusive).'),
        },
        required: ['from', 'to'],
      },
    },
  },
  {
    name: 'get_treasury_accounts',
    label: 'Saldos de tesorería',
    summary: 'El saldo de cada caja, banco y billetera, con el total del negocio.',
    permission: 'canAccessBanks',
    exposesProfit: false,
    declaration: {
      name: 'get_treasury_accounts',
      description:
        'Saldo actual de todas las cajas del negocio: cajas de los cajeros, bancos y billeteras, con el total consolidado.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    name: 'get_businesses_overview',
    label: 'Resumen de tus negocios',
    summary: 'Cómo van todos tus negocios (principal y sucursales) en un día, con el total.',
    permission: 'canAccessDashboard',
    exposesProfit: true,
    requires_branches: true,
    declaration: {
      name: 'get_businesses_overview',
      description:
        'Día de TODOS los negocios del dueño (principal y sucursales activas) en una llamada, con el total: recaudo, ventas, créditos, pedidos, ganancia, margen, gastos, ganancia real y saldo en cajas. Para "¿cómo van mis negocios?" o comparar sucursales.',
      parameters: {
        type: 'object',
        properties: {
          date: dateParam('Día a consultar. Si se omite, hoy.'),
        },
      },
    },
  },
  {
    name: 'register_expense',
    label: 'Preparando gasto',
    summary:
      'Registra gastos variables (concepto, valor y de dónde sale el dinero), siempre con tu confirmación.',
    permission: 'canAccessExpenses',
    exposesProfit: false,
    requires_administrator: true,
    declaration: {
      name: 'register_expense',
      description:
        'PREPARA el registro de un GASTO VARIABLE; NO lo registra todavía. Necesita los TRES datos dichos por el usuario: concepto, valor y la cuenta de la que sale el dinero (la caja, un banco o una billetera). NUNCA inventes ni supongas ninguno: si falta alguno, llama igual sin ese dato y la herramienta te dirá qué falta y qué cuentas existen, para que se lo preguntes. Si todo es válido devuelve status "confirmation_required" con el resumen exacto: muéstraselo al usuario y pídele que responda "sí" para registrarlo. No llames confirm_expense_action en esa misma respuesta.',
      parameters: {
        type: 'object',
        properties: {
          description: {
            type: 'string',
            description:
              'Concepto del gasto, tal cual lo dijo el usuario (ej. "Pago de luz"). Sin inventar ni completar.',
          },
          amount: {
            type: 'number',
            description:
              'Valor en pesos como número, sin separadores de miles ni símbolo: "50 mil" → 50000, "$1.200.000" → 1200000. Si la cifra es ambigua, pregúntala.',
          },
          source: {
            type: 'string',
            description:
              'De dónde sale el dinero, tal cual lo dijo el usuario: "caja", o el nombre del banco o billetera (ej. "Bancolombia", "Nequi"). Omítelo si el usuario no lo dijo.',
          },
        },
      },
    },
  },
  {
    name: 'void_expense',
    label: 'Buscando gasto a archivar',
    summary:
      'Archiva (anula) un gasto variable y devuelve el dinero a su cuenta, siempre con tu confirmación.',
    permission: 'canAccessExpenses',
    exposesProfit: false,
    requires_administrator: true,
    declaration: {
      name: 'void_expense',
      description:
        'PREPARA el archivo (anulación) de un GASTO VARIABLE; NO lo archiva todavía. Archivar devuelve el dinero a la cuenta de la que salió. Los gastos no se pueden editar: para corregir uno se archiva y se registra de nuevo. Busca por el concepto ("query") y, para afinar, por valor ("amount") y día ("date"); o recibe directamente "expense_id" si el usuario eligió un gasto de una lista (el número de referencia #). Si hay varios que coinciden devuelve status "multiple_matches": muéstralos SIEMPRE con su referencia "#id", fecha, valor y cuenta, y pregunta cuál. Si hay uno solo devuelve "confirmation_required": muestra el resumen y pide que responda "sí". No llames confirm_expense_action en esa misma respuesta.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Concepto del gasto a archivar, tal cual lo dijo el usuario.',
          },
          expense_id: {
            type: 'integer',
            description:
              'Referencia (#) del gasto elegido por el usuario de una lista que ya le mostraste.',
          },
          amount: {
            type: 'number',
            description: 'Opcional: valor exacto del gasto, como número sin separadores.',
          },
          date: dateParam('Opcional: día en que se registró el gasto.'),
        },
      },
    },
  },
  {
    name: 'confirm_expense_action',
    label: 'Ejecutando operación',
    summary: 'Ejecuta el registro o archivo de gasto que acabas de confirmar.',
    permission: 'canAccessExpenses',
    exposesProfit: false,
    requires_administrator: true,
    is_listed: false,
    declaration: {
      name: 'confirm_expense_action',
      description:
        'EJECUTA el registro o archivo de gasto que preparaste en tu respuesta anterior, SOLO cuando el último mensaje del usuario es un "sí" explícito a ese resumen. Si el usuario cambió algún dato, dijo que no o preguntó algo, NO la llames: vuelve a preparar con los datos correctos. Solo después de que devuelva status "executed" puedes decir que quedó hecho; con cualquier otro status, explícale al usuario lo que dice el campo "message".',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    name: 'prepare_sale',
    label: 'Preparando pedido',
    summary:
      'Registra ventas como pedido por cobrar: interpreta los productos, te muestra la factura y la crea con tu confirmación.',
    permission: 'canAccessPOS',
    exposesProfit: false,
    requires_administrator: true,
    declaration: {
      name: 'prepare_sale',
      description:
        'PREPARA una venta como PEDIDO POR COBRAR (queda en Tickets del POS para cobrarla allí); NO la crea todavía. Úsala cuando el usuario pida registrar/facturar/venderle algo a un cliente. Interpreta y busca cada producto en el inventario por su nombre (tolera tildes, mayúsculas, plurales, abreviaturas y tamaños: "por libra", "x media libra", "500 gr"). En UNA sola llamada manda el cliente y TODAS las líneas. Devuelve "needs_input" si algo no está claro (producto ambiguo, tamaño inexistente con alternativas y su cantidad equivalente, cliente ambiguo, cantidad faltante): pregúntale al usuario SOLO eso y vuelve a llamar con todas las líneas usando los product_id / customer_id elegidos. Devuelve "confirmation_required" con la vista previa de la factura: muéstrala y pide que responda "sí". No llames confirm_sale en esa misma respuesta.',
      parameters: {
        type: 'object',
        properties: {
          customer: {
            type: 'string',
            description:
              'Cliente tal cual lo dijo el usuario (nombre, documento o teléfono). Omítelo si no dijo cliente (queda de mostrador).',
          },
          customer_id: {
            type: 'integer',
            description:
              'Solo un customer_id que la herramienta te devolvió en ESTA misma respuesta. Los ids NO se conservan entre mensajes: si el usuario eligió un cliente en su último mensaje, manda su NOMBRE EXACTO en "customer".',
          },
          items: {
            type: 'array',
            description: 'Las líneas del pedido, en el orden en que las dijo el usuario.',
            items: {
              type: 'object',
              properties: {
                query: {
                  type: 'string',
                  description:
                    'El producto como lo nombró el usuario, CON su tamaño o presentación y SIN la cantidad: "2 libras de fécula de maíz" → query "fécula de maíz por libra", quantity 2; "media libra de fécula" → query "fécula por media libra", quantity 1.',
                },
                alternatives: {
                  type: 'array',
                  items: { type: 'string' },
                  description:
                    'Hasta 4 nombres alternativos del MISMO producto cuando el usuario usa una marca o nombre coloquial: "maizena por libra" → ["fécula de maíz por libra"]. Mantén el tamaño.',
                },
                product_id: {
                  type: 'integer',
                  description:
                    'Solo un product_id que la herramienta te devolvió en ESTA misma respuesta (nunca uno de memoria). Los ids NO se conservan entre mensajes: si el usuario eligió una opción en su último mensaje, manda el NOMBRE EXACTO de esa opción en "query".',
                },
                quantity: {
                  type: 'number',
                  description:
                    'Cuántas unidades del tamaño que dice query, como número (1, 2, 500). El tamaño NUNCA se repite en la cantidad: "media libra de X" es quantity 1 de "X por media libra", jamás 0.5. Si el usuario no dijo la cantidad, omítela y la herramienta te pedirá preguntarla.',
                },
                price_level: {
                  type: 'string',
                  description:
                    'Opcional: nombre del nivel de precio que pidió el usuario (ej. "mayorista"). Si se omite, el precio por defecto del POS.',
                },
                unit_price: {
                  type: 'number',
                  description:
                    'Opcional: precio unitario MANUAL que dijo el usuario, como número sin separadores ("4 mil" → 4000). Solo si lo pidió explícitamente.',
                },
                note: {
                  type: 'string',
                  description: 'Opcional: nota de la línea que dictó el usuario.',
                },
              },
            },
          },
        },
      },
    },
  },
  {
    name: 'confirm_sale',
    label: 'Creando pedido',
    summary: 'Crea el pedido que acabas de confirmar.',
    permission: 'canAccessPOS',
    exposesProfit: false,
    requires_administrator: true,
    is_listed: false,
    declaration: {
      name: 'confirm_sale',
      description:
        'CREA el pedido que preparaste con prepare_sale en tu respuesta anterior, SOLO cuando el último mensaje del usuario es un "sí" explícito a esa vista previa. Si el usuario cambió algo, dijo que no o preguntó otra cosa, NO la llames: vuelve a llamar prepare_sale. Solo después de que devuelva status "executed" puedes decir que quedó creado (con el número de ticket); con cualquier otro status, explica su "message".',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    name: 'prepare_treasury_transfer',
    label: 'Preparando movimiento',
    summary: 'Mueve saldo entre cajas, bancos y billeteras, siempre con tu confirmación.',
    permission: 'canAccessBanks',
    exposesProfit: false,
    requires_administrator: true,
    requires_owner: true,
    declaration: {
      name: 'prepare_treasury_transfer',
      description:
        'PREPARA mover dinero entre cuentas (caja, banco, billetera); NO lo mueve. Si falta un dato, llama igual: te dice qué preguntar y qué cuentas hay.',
      parameters: {
        type: 'object',
        properties: {
          from: {
            type: 'string',
            description:
              'Origen como lo dijo el usuario ("banco Nequi", "caja de Ana", "mi caja").',
          },
          to: { type: 'string', description: 'Destino, igual que from.' },
          amount: {
            type: 'number',
            description: 'Pesos sin separadores ("100 mil" → 100000).',
          },
        },
      },
    },
  },
  {
    name: 'prepare_balance_correction',
    label: 'Preparando corrección',
    summary: 'Corrige el saldo de una caja, banco o billetera al valor real, con tu confirmación.',
    permission: 'canAccessBanks',
    exposesProfit: false,
    requires_administrator: true,
    requires_owner: true,
    declaration: {
      name: 'prepare_balance_correction',
      description:
        'PREPARA dejar UNA cuenta EXACTAMENTE en target_balance, sea cual sea su saldo ("corrige Nequi a 10 mil"); NO la corrige.',
      parameters: {
        type: 'object',
        properties: {
          account: {
            type: 'string',
            description: 'Cuenta como la dijo el usuario.',
          },
          target_balance: {
            type: 'number',
            description: 'Saldo final, pesos sin separadores (puede ser 0).',
          },
          reason: { type: 'string', description: 'Motivo, solo si el usuario lo dijo.' },
        },
      },
    },
  },
  {
    name: 'confirm_treasury_action',
    label: 'Ejecutando movimiento',
    summary: 'Ejecuta el movimiento o la corrección de saldo que acabas de confirmar.',
    permission: 'canAccessBanks',
    exposesProfit: false,
    requires_administrator: true,
    requires_owner: true,
    is_listed: false,
    declaration: {
      name: 'confirm_treasury_action',
      description:
        'EJECUTA el movimiento o corrección preparado antes, SOLO si el último mensaje del usuario es un "sí" a ese resumen.',
      parameters: { type: 'object', properties: {} },
    },
  },
] as const;

const TOOLS_BY_NAME = new Map<string, AiToolDefinition>(AI_TOOLS.map((tool) => [tool.name, tool]));

export const findTool = (name: string): AiToolDefinition | undefined => TOOLS_BY_NAME.get(name);

/** Actor mínimo necesario para decidir qué herramientas se ofrecen. */
export interface AiToolActor extends AiBusinessScopeActor {
  /** owner/superadmin: acceso total, no dependen del catálogo. */
  isAdmin: boolean;
  permissions: ReadonlySet<string>;
  /** Empleado sin visibilidad de ganancias: se le ocultan costos y márgenes. */
  canViewProfit: boolean;
  /** Id del usuario, para acotar las ventas a las suyas cuando corresponda. */
  userId: number;
  /**
   * Owner/superadmin, o empleado con el rol de fábrica "Administrador"
   * (inmutable). Habilita las herramientas que ESCRIBEN (`requires_administrator`).
   */
  is_administrator: boolean;
  /** Nombre completo: firma de los gastos que registre/archive Place. */
  full_name?: string;
}

/**
 * ¿Ve las ventas de TODO el equipo o solo las suyas? Misma regla que los
 * informes (`canViewAllSales`): el owner siempre, el empleado según su rol.
 * Devuelve el id al que hay que acotar, o `null` si las ve todas.
 */
export const salesScopeUserId = (actor: AiToolActor): number | null =>
  actor.isAdmin || actor.permissions.has('canViewAllSales') ? null : actor.userId;

/**
 * ¿La herramienta puede correr contra otro negocio del owner (`business_id`)?
 * Solo las de lectura sobre UN negocio: las que escriben operan siempre en el
 * negocio de la sesión, y el consolidado ya cubre a todos.
 */
export const acceptsBusinessScope = (tool: AiToolDefinition): boolean =>
  tool.requires_administrator !== true &&
  tool.requires_owner !== true &&
  tool.requires_branches !== true;

export const isToolAllowed = (tool: AiToolDefinition, actor: AiToolActor): boolean => {
  // `businesses` solo lo trae el owner: sin sucursales no hay consolidado.
  if (tool.requires_branches === true && !hasMultipleBusinesses(actor)) {
    return false;
  }
  // Escritura: fail-closed. Ni el permiso del módulo basta sin el rol.
  if (tool.requires_owner === true && !actor.isAdmin) {
    return false;
  }
  if (tool.requires_administrator === true && !actor.isAdmin && actor.is_administrator !== true) {
    return false;
  }
  if (tool.permission === null) {
    return true;
  }
  if (actor.isAdmin) {
    return true;
  }
  return actor.permissions.has(tool.permission);
};

/** Herramientas que este actor puede usar de verdad. */
export const allowedToolsFor = (actor: AiToolActor): AiToolDefinition[] =>
  AI_TOOLS.filter((tool) => isToolAllowed(tool, actor));

/**
 * Declaraciones que se le mandan al modelo, ya filtradas por permisos. Al owner
 * con sucursales se le agrega `business_id` a las de lectura; a los demás, nada.
 */
export const declarationsFor = (actor: AiToolActor): GeminiFunctionDeclaration[] => {
  const multi_business = hasMultipleBusinesses(actor);
  return allowedToolsFor(actor).map((tool) =>
    multi_business && acceptsBusinessScope(tool)
      ? withBusinessIdParam(tool.declaration)
      : tool.declaration,
  );
};

/** Lo que ve el usuario en "qué puedo consultar": solo lo que de verdad puede. */
export interface AiToolSummary {
  name: AiToolName;
  label: string;
  summary: string;
}

export const toolSummariesFor = (actor: AiToolActor): AiToolSummary[] =>
  allowedToolsFor(actor)
    .filter((tool) => tool.is_listed !== false)
    .map((tool) => ({
      name: tool.name,
      label: tool.label,
      summary: tool.summary,
    }));

/**
 * Claves de costo/ganancia/margen que se eliminan del resultado cuando el
 * empleado no tiene visibilidad de ganancias. Recursivo: los resultados vienen
 * anidados (series, listas de productos, etc.).
 */
const PROFIT_KEYS = new Set([
  'cost',
  'totalCost',
  'profit',
  'totalProfit',
  'salesProfit',
  'realProfit',
  'salesRealProfit',
  'real_profit',
  'surplus',
  'salesSurplus',
  'margin',
  'avgMargin',
  'marginPercentage',
]);

export const stripProfitFields = <T>(value: T, canViewProfit: boolean): T => {
  if (canViewProfit) {
    return value;
  }
  if (Array.isArray(value)) {
    const items: unknown[] = value.map((item: unknown) => stripProfitFields(item, canViewProfit));
    return items as unknown as T;
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([key]) => !PROFIT_KEYS.has(key))
      .map(([key, item]) => [key, stripProfitFields(item, canViewProfit)] as const);
    return Object.fromEntries(entries) as unknown as T;
  }
  return value;
};
