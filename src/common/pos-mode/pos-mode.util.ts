/**
 * Tipo de negocio (modo de operación) de una company. El nombre `pos_mode` es
 * histórico: nació eligiendo la ventana de POS, pero hoy decide la app entera.
 *
 *   - `retail`: el POS de siempre (búsqueda de productos + carrito). Default.
 *   - `restaurant`: POS dedicado a restaurantes y bares (mesas / salones).
 *   - `lender`: prestamistas. Sin punto de venta: la app se reduce a Inicio,
 *     Clientes, Tesorería y la cartera de dinero prestado.
 *
 * Se elige por negocio desde el panel superadmin (kdevs-admin) y viaja en el
 * perfil del login: el cliente Electron decide con él qué ventanas, rutas y
 * opciones del dashboard ofrece.
 */
export const POS_MODES = ['retail', 'restaurant', 'lender'] as const;

export type PosMode = (typeof POS_MODES)[number];

export const DEFAULT_POS_MODE: PosMode = 'retail';

export function isPosMode(value: unknown): value is PosMode {
  return typeof value === 'string' && (POS_MODES as readonly string[]).includes(value);
}

/**
 * Normaliza un valor cualquiera a un `PosMode` válido. Todo lo que no sea un
 * modo conocido (null, undefined, basura de una fila vieja) cae en `retail`:
 * ante la duda el negocio debe seguir vendiendo con el POS de siempre.
 */
export function resolvePosMode(value: unknown): PosMode {
  return isPosMode(value) ? value : DEFAULT_POS_MODE;
}
