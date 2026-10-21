/**
 * SQL de las herramientas de TESORERÍA de Place.
 *
 * Solo lecturas: el débito/crédito de cada cuenta lo hacen las acciones
 * canónicas de la app (`TransferAction`, `TransferCashAction`, ajustes de
 * banco/billetera/caja), que son la única fuente de verdad de cómo se mueve el
 * dinero. Toda query filtra por `company_id`.
 */

/**
 * Todas las cuentas entre las que se puede mover dinero, en UN viaje:
 * cajas de los usuarios de la company (nombre del dueño), bancos y billeteras
 * activos. Montos como texto: se leen con Big.js, nunca como float.
 *
 * La caja se une a `users` SIN exigir `u.company_id = $1`: en una sucursal la
 * caja del owner es de la sucursal pero su usuario vive en el principal. El
 * scope lo da `cr.company_id`. El superadmin no tiene caja de negocio.
 *
 * $1 = company_id, $2 = user_id del actor.
 */
export const TREASURY_ACCOUNTS_SQL = `
  SELECT 'cash_register'::text AS kind, cr.id::text AS id, cr.user_id::text AS user_id,
         btrim(concat_ws(' ', u.name, u.lastname)) AS name, NULL::text AS account_number,
         cr.balance::text AS balance, (cr.user_id = $2) AS is_own
    FROM cash_registers cr
    JOIN users u ON u.id = cr.user_id AND u.type <> 'superadmin'
   WHERE cr.company_id = $1
  UNION ALL
  SELECT 'bank', b.id::text, NULL, b.name, b.account_number, b.balance::text, false
    FROM banks b
   WHERE b.company_id = $1 AND b.is_archived = false
  UNION ALL
  SELECT 'wallet', w.id::text, NULL, w.name, NULL, w.balance::text, false
    FROM wallets w
   WHERE w.company_id = $1 AND w.is_archived = false
`;

/**
 * Saldo actual de la cuenta a corregir, BLOQUEADO hasta el fin de la
 * transacción de confirmación: se compara con el que vio el usuario en el
 * resumen y, si cambió, no se corrige (la diferencia ya no es la confirmada).
 *
 * $1 = id (banco/billetera) o user_id (caja), $2 = company_id.
 */
export const LOCK_BALANCE_SQL = {
  bank: `SELECT balance::text AS balance FROM banks
          WHERE id = $1 AND company_id = $2 AND is_archived = false FOR UPDATE`,
  wallet: `SELECT balance::text AS balance FROM wallets
            WHERE id = $1 AND company_id = $2 AND is_archived = false FOR UPDATE`,
  cash_register: `SELECT balance::text AS balance FROM cash_registers
                   WHERE user_id = $1 AND company_id = $2 FOR UPDATE`,
} as const;
