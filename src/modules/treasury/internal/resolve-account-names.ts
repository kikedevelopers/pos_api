/**
 * Lógica PURA (sin DB ni DI) del Resumen de tesorería. Resuelve el nombre de la
 * cuenta origen/destino de un movimiento a partir de los mapas de nombres
 * (bancos, billeteras, cajas). Espejo de
 * `placepos/src/main/server/routes/treasury.helpers.ts`.
 */

export interface AccountNameRow {
  id: number;
  name: string | null;
}

export interface MovementLike {
  source_type: string | null;
  source_id: number | null;
  destination_type: string | null;
  destination_id: number | null;
}

export type NameResolver = (type: string | null, id: number | null) => string | null;

/**
 * Construye un resolvedor de nombres de cuenta. Los tipos desconocidos o
 * `external` devuelven `null` (no es una caja del negocio); las cuentas no
 * encontradas (p. ej. borradas) caen a una etiqueta genérica por tipo.
 */
export const buildNameResolver = (
  bankRows: AccountNameRow[],
  walletRows: AccountNameRow[],
  registerRows: AccountNameRow[],
): NameResolver => {
  const bankMap = new Map(bankRows.map((r) => [r.id, r.name]));
  const walletMap = new Map(walletRows.map((r) => [r.id, r.name]));
  const registerMap = new Map(registerRows.map((r) => [r.id, r.name]));

  return (type, id) => {
    if (!type || id == null) return null;
    switch (type) {
      case 'bank':
        return bankMap.get(id) ?? 'Banco';
      case 'wallet':
        return walletMap.get(id) ?? 'Billetera';
      case 'cash_register':
        return registerMap.get(id)?.trim() || 'Caja de cajero';
      default:
        return null;
    }
  };
};

/** Devuelve los nombres resueltos de origen/destino de un movimiento. */
export const resolveMovementNames = (
  movement: MovementLike,
  resolve: NameResolver,
): { source_name: string | null; destination_name: string | null } => ({
  source_name: resolve(movement.source_type, movement.source_id),
  destination_name: resolve(movement.destination_type, movement.destination_id),
});
