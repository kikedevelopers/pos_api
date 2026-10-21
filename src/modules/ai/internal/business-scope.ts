import type { GeminiFunctionDeclaration } from './gemini.types';
import { readNumber } from './tool-args';

/**
 * Alcance multi-sucursal de Place: el OWNER (y solo él) puede preguntar por
 * cualquiera de sus negocios —principal y sucursales— sin cambiar de sesión.
 *
 * Diseño de mínimo costo en tokens:
 *   - La lista de negocios va UNA vez en el prompt (`#id nombre`), así el
 *     modelo reconoce "¿cómo va Norte?" sin gastar una llamada en buscarlo.
 *   - Las herramientas de LECTURA reciben un parámetro opcional `business_id`
 *     que solo se declara si el owner tiene sucursales: a nadie más le cuesta
 *     un solo token.
 *   - Las de ESCRITURA (gastos, pedidos) nunca lo aceptan: solo operan sobre
 *     el negocio de la sesión.
 *
 * Seguridad: el `business_id` del modelo se valida SIEMPRE contra los negocios
 * del owner (`company_members`, resueltos por el servidor). Un id ajeno, de una
 * sucursal suspendida o pedido por un no-owner se rechaza (anti-IDOR).
 */

/** Un negocio del owner (fila de `company_members` + `companies`). */
export interface AiBusiness {
  id: number;
  name: string;
  is_branch: boolean;
  /** Sucursal suspendida (`company_members.is_active=false`): no se consulta. */
  is_active: boolean;
}

/** Lo mínimo del actor que necesita el alcance por negocio. */
export interface AiBusinessScopeActor {
  /** Negocios del OWNER. Vacío/ausente para cualquier otro usuario. */
  businesses?: readonly AiBusiness[];
}

export const BUSINESS_ID_PARAM = 'business_id';

/** Negocios que se pueden consultar: el principal siempre, sucursales activas. */
export const queryableBusinesses = (actor: AiBusinessScopeActor): AiBusiness[] =>
  (actor.businesses ?? []).filter((business) => !business.is_branch || business.is_active);

/** ¿El owner tiene al menos una sucursal consultable además del negocio actual? */
export const hasMultipleBusinesses = (actor: AiBusinessScopeActor): boolean =>
  queryableBusinesses(actor).length > 1;

/**
 * Declara `business_id` en la herramienta (copia, sin mutar el catálogo).
 */
export const withBusinessIdParam = (
  declaration: GeminiFunctionDeclaration,
): GeminiFunctionDeclaration => ({
  ...declaration,
  parameters: {
    type: 'object',
    ...declaration.parameters,
    properties: {
      ...(declaration.parameters?.properties ?? {}),
      // Sin descripción a propósito: se declararía 11 veces por ronda; cómo
      // usarlo ya lo explican BUSINESS_SCOPE_RULES una sola vez.
      [BUSINESS_ID_PARAM]: { type: 'integer' },
    },
  },
});

export type BusinessScopeResult =
  | { ok: true; company_id: number; business: AiBusiness | null }
  | { ok: false; error: string };

/**
 * Decide contra qué company corre una herramienta.
 *
 * - Sin `business_id` (o igual al actual) → la company de la sesión,
 *   `business: null` (respuesta idéntica a la de siempre).
 * - Con otro `business_id` → solo si la herramienta acepta alcance, el actor es
 *   owner y el id es uno de SUS negocios consultables.
 */
export const resolveBusinessScope = (
  actor: AiBusinessScopeActor,
  current_company_id: number,
  args: Record<string, unknown>,
  accepts_scope: boolean,
): BusinessScopeResult => {
  const raw = args?.[BUSINESS_ID_PARAM];
  if (raw === undefined || raw === null || raw === '') {
    return { ok: true, company_id: current_company_id, business: null };
  }

  // Sin acotar: un 0 o un -3 deben rechazarse, no convertirse en otro id.
  const business_id = readNumber(args, BUSINESS_ID_PARAM, Number.NaN, -Infinity, Infinity);
  if (!Number.isSafeInteger(business_id) || business_id <= 0) {
    return {
      ok: false,
      error: 'El business_id no es válido: usa el # de la lista de TUS NEGOCIOS.',
    };
  }
  if (business_id === current_company_id) {
    return { ok: true, company_id: current_company_id, business: null };
  }
  if (!accepts_scope) {
    return {
      ok: false,
      error:
        'Esta operación solo se puede hacer en el negocio actual. Dile al usuario que cambie a ese negocio en PlacePOS para hacerla allí.',
    };
  }

  const business = (actor.businesses ?? []).find((item) => item.id === business_id);
  if (!business) {
    return {
      ok: false,
      error:
        'Ese negocio no está entre los negocios del usuario. No inventes ids: usa solo los de TUS NEGOCIOS.',
    };
  }
  if (business.is_branch && !business.is_active) {
    return {
      ok: false,
      error: `La sucursal "${business.name}" está suspendida: sus datos no se pueden consultar hasta que se reactive.`,
    };
  }
  return { ok: true, company_id: business.id, business };
};

/**
 * Bloque del prompt con los negocios del owner. `null` si el usuario no es
 * owner (no se le dice nada de sucursales). Va al FINAL del prompt (cambia por
 * negocio), para no romper el prefijo cacheable.
 */
export const buildBusinessesContext = (
  actor: AiBusinessScopeActor,
  current_company_id: number,
): string[] | null => {
  const businesses = actor.businesses ?? [];
  if (businesses.length === 0) {
    return null;
  }

  if (!hasMultipleBusinesses(actor)) {
    const main = businesses.find((business) => !business.is_branch) ?? businesses[0];
    return [
      `- TUS NEGOCIOS: solo el negocio principal (${main.name}); el dueño NO tiene sucursales activas. Si pregunta por sus sucursales, "mis negocios" o "todos", empieza diciéndole que solo tiene este negocio y responde con sus datos.`,
    ];
  }

  const lines = businesses.map((business) => {
    const kind = business.is_branch
      ? business.is_active
        ? 'sucursal'
        : 'sucursal SUSPENDIDA, no consultable'
      : 'principal';
    const current = business.id === current_company_id ? ', ACTUAL' : '';
    return `  #${business.id} ${business.name} (${kind}${current})`;
  });
  return ['- TUS NEGOCIOS (todos del mismo dueño):', ...lines];
};

/**
 * Reglas de uso del alcance multi-negocio. Texto fijo: solo se incluye si el
 * owner tiene sucursales, y va antes del contexto variable.
 */
export const BUSINESS_SCOPE_RULES: readonly string[] = [
  'VARIOS NEGOCIOS',
  '- El dueño tiene varios negocios, todos suyos (TUS NEGOCIOS, al final): consúltalos aunque esté conectado a otro.',
  '- Sin business_id las herramientas usan el negocio ACTUAL. Si nombra otro ("¿cómo va Norte?"), búscalo en la lista por nombre aproximado y pasa su # como business_id; si encaja con varios o ninguno, pregunta cuál.',
  '- "Mis negocios", "todos" o comparar negocios en un día → get_businesses_overview (una llamada). Otro dato de varios → una llamada por negocio.',
  '- Di de qué negocio es cada cifra, SOLO por su nombre (nunca escribas el # ni business_id); con varios, tabla por negocio y total.',
  '- Gastos y pedidos solo en el negocio ACTUAL: para otro, que cambie de negocio en PlacePOS.',
  '',
];
