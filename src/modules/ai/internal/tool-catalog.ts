import type { PermissionKey } from '@/modules/roles/internal/permission-catalog';

import type { GeminiFunctionDeclaration } from './gemini.types';

/**
 * Catálogo de herramientas que PlacePOS IA puede ejecutar contra la base de
 * datos del negocio. TODAS son de solo lectura y todas se filtran por
 * `company_id` en su implementación (`run-tool.action.ts`).
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
  'get_expenses_summary',
  'get_treasury_accounts',
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
    summary:
      'Cómo va el día: recaudo, ventas, ganancia, gastos y saldos de caja.',
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
    summary:
      'Las ventas una por una: ticket, hora, cliente, productos y forma de pago.',
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
    summary:
      'Tendencia de un rango de fechas: ventas, ganancia, gastos y créditos, día por día.',
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
    summary:
      'Los productos que más se venden, con su ganancia y margen.',
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
    summary:
      'Cualquier producto del inventario: existencias, costo, precios y empaque.',
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
    summary:
      'Lo que está por agotarse, de lo más crítico a lo menos.',
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
    summary:
      'La cartera: cuánto te deben y quiénes tienen la deuda más vieja.',
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
    summary:
      'Tus clientes: deuda, anticipos, puntos y su última compra.',
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
    name: 'get_expenses_summary',
    label: 'Gastos del período',
    summary:
      'Los gastos de un período: total, fijos vs. variables y por categoría.',
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
    summary:
      'El saldo de cada caja, banco y billetera, con el total del negocio.',
    permission: 'canAccessBanks',
    exposesProfit: false,
    declaration: {
      name: 'get_treasury_accounts',
      description:
        'Saldo actual de todas las cajas del negocio: cajas de los cajeros, bancos y billeteras, con el total consolidado.',
      parameters: { type: 'object', properties: {} },
    },
  },
] as const;

const TOOLS_BY_NAME = new Map<string, AiToolDefinition>(AI_TOOLS.map((tool) => [tool.name, tool]));

export const findTool = (name: string): AiToolDefinition | undefined => TOOLS_BY_NAME.get(name);

/** Actor mínimo necesario para decidir qué herramientas se ofrecen. */
export interface AiToolActor {
  /** owner/superadmin: acceso total, no dependen del catálogo. */
  isAdmin: boolean;
  permissions: ReadonlySet<string>;
  /** Empleado sin visibilidad de ganancias: se le ocultan costos y márgenes. */
  canViewProfit: boolean;
  /** Id del usuario, para acotar las ventas a las suyas cuando corresponda. */
  userId: number;
}

/**
 * ¿Ve las ventas de TODO el equipo o solo las suyas? Misma regla que los
 * informes (`canViewAllSales`): el owner siempre, el empleado según su rol.
 * Devuelve el id al que hay que acotar, o `null` si las ve todas.
 */
export const salesScopeUserId = (actor: AiToolActor): number | null =>
  actor.isAdmin || actor.permissions.has('canViewAllSales') ? null : actor.userId;

export const isToolAllowed = (tool: AiToolDefinition, actor: AiToolActor): boolean => {
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

/** Declaraciones que se le mandan al modelo, ya filtradas por permisos. */
export const declarationsFor = (actor: AiToolActor): GeminiFunctionDeclaration[] =>
  allowedToolsFor(actor).map((tool) => tool.declaration);

/** Lo que ve el usuario en "qué puedo consultar": solo lo que de verdad puede. */
export interface AiToolSummary {
  name: AiToolName;
  label: string;
  summary: string;
}

export const toolSummariesFor = (actor: AiToolActor): AiToolSummary[] =>
  allowedToolsFor(actor).map((tool) => ({
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
