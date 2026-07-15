import type { EntityManager } from 'typeorm';

import { TicketSettingType } from '../entities/ticket-setting.entity';

/**
 * Resincronización de `ticket_settings.current_number` con los folios REALMENTE
 * emitidos en la data de una company.
 *
 * --------------------------------------------------------------------------
 * Por qué existe
 * --------------------------------------------------------------------------
 *
 * `IncrementTicketNumberAction` es atómico y por sí solo nunca repite folio:
 * el `UPDATE ... RETURNING` garantiza valores disjuntos. Pero asume que el
 * contador va SIEMPRE por delante de los folios ya persistidos, y hay un
 * camino que rompe esa premisa: `ImportTenantAction` REEMPLAZA la data de
 * negocio del destino con la del respaldo (incluidas `sale_invoices` con sus
 * `ticket_number` originales) mientras CONSERVA los `ticket_settings` del
 * destino (están en `PRESERVED_TABLES`, para no pisar el prefix/suffix que el
 * owner configuró). Resultado: contador del destino + folios del origen, con
 * el contador potencialmente MUY por detrás.
 *
 * Cuando eso pasa, la siguiente venta genera un folio ya ocupado y revienta
 * contra `idx_sale_invoices_company_ticket_number_unique` (23505 →
 * `SALE_TICKET_NUMBER_DUPLICATE`). Y es un bloqueo PERMANENTE, no transitorio:
 * el incremento vive dentro de la transacción de la venta, así que el rollback
 * lo deshace y el reintento vuelve a pedir exactamente el mismo folio ocupado.
 *
 * La cura es resincronizar el contador con la realidad al final del import.
 *
 * --------------------------------------------------------------------------
 * Regla: el contador NUNCA retrocede
 * --------------------------------------------------------------------------
 *
 * Solo se sube el contador (`WHERE m.n > ts.current_number`), jamás se baja.
 * Un import con reemplazo borra los folios viejos del destino, así que bajarlo
 * sería técnicamente viable — pero reusar un número ya emitido en una empresa
 * real es indeseable para auditoría, y mantenerlo monótono hace la operación
 * IDEMPOTENTE (correrla dos veces no cambia nada) y segura frente a cualquier
 * tabla que esta lista no contemple.
 *
 * --------------------------------------------------------------------------
 * Cómo se extrae el número de un folio
 * --------------------------------------------------------------------------
 *
 * `formatTicketNumber` produce `PREFIX-NNN-SUFFIX` / `PREFIX-NNN` / `NNN-SUFFIX`
 * / `NNN`. Los folios persistidos llevan el prefix VIGENTE AL EMITIRSE, que
 * puede no ser el actual (y en un import cross-company es directamente el de
 * otra empresa), así que no se puede parsear contra la config de hoy.
 *
 * Se parte el folio por `-` y se toma el MÁXIMO de los segmentos puramente
 * numéricos. La propiedad que importa es que NUNCA SUBESTIMA: el segmento del
 * número siempre está entre los candidatos, así que el máximo por fila es
 * siempre >= el número real, y por tanto el contador nunca queda por debajo del
 * folio más alto emitido (subestimar = colisión; sobreestimar = solo saltarse
 * números, inocuo). Solo sobreestima si el prefix/suffix es puramente numérico
 * Y mayor que el folio — un caso degenerado y sin consecuencias.
 *
 * El filtro `^[0-9]{1,15}$` acota a `bigint`: un segmento de 16+ dígitos no es
 * un folio y castearlo reventaría la query.
 */

/** Tabla/columna que respalda cada contador, con su filtro discriminante. */
export interface TicketCounterSource {
  type: TicketSettingType;
  table: string;
  column: string;
  /** Filtro extra cuando una tabla respalda más de un tipo de folio. */
  where: string | null;
}

/**
 * Fuente de verdad de cada contador. Un tipo que no emita folio en ninguna
 * tabla no puede colisionar y no necesita entrada aquí.
 *
 * `deliveries.ticket_number` NO está: es un snapshot del folio de la venta
 * (`create-delivery.action.ts`), no consume el contador.
 */
export const TICKET_COUNTER_SOURCES: readonly TicketCounterSource[] = [
  // El folio del ticket nace SIEMPRE del contador ORDER (la venta nace ORDER),
  // así que cuentan todas las filas, sean ORDER o SALE.
  { type: TicketSettingType.ORDER, table: 'sale_invoices', column: 'ticket_number', where: null },
  // `sale_number` se asigna al convertir ORDER → SALE; es NULL mientras sea pedido.
  {
    type: TicketSettingType.SALE,
    table: 'sale_invoices',
    column: 'sale_number',
    where: 'sale_number IS NOT NULL',
  },
  // Notas crédito y débito comparten tabla y columna; las separa `note_type`.
  {
    type: TicketSettingType.CREDIT_NOTE,
    table: 'credit_notes',
    column: 'note_number',
    where: "note_type = 'CREDIT'",
  },
  {
    type: TicketSettingType.DEBIT_NOTE,
    table: 'credit_notes',
    column: 'note_number',
    where: "note_type = 'DEBIT'",
  },
  { type: TicketSettingType.PURCHASE, table: 'purchases', column: 'purchase_number', where: null },
  {
    type: TicketSettingType.PURCHASE_PAYMENT,
    table: 'purchase_payments',
    column: 'payment_number',
    where: null,
  },
];

/**
 * SQL que extrae el número de un folio: máximo de los segmentos numéricos.
 * Devuelve NULL si ningún segmento lo es (folio sin dígitos → fila ignorada).
 */
function maxNumericSegmentSql(table: string, column: string): string {
  return `(
        SELECT max(seg::bigint)
          FROM unnest(regexp_split_to_array(${table}.${column}, '-')) AS seg
         WHERE seg ~ '^[0-9]{1,15}$'
      )`;
}

/**
 * Construye el UPDATE de resincronización.
 *
 * El UPDATE va dentro de un CTE y la sentencia CIERRA con un `SELECT`: así el
 * comando es SELECT y el driver devuelve las filas tal cual. Un `UPDATE ...
 * RETURNING` suelto devuelve `[filas, affected]` en TypeORM, una forma
 * ambigua que hay que destripar; el CTE la evita. La sentencia sigue
 * ejecutando el UPDATE (CTE que modifica datos), corra o no alguien el SELECT.
 *
 * @param scoped `true` → acota a una company vía `$1`. `false` → todas las
 *               companies (la migración correctiva).
 */
export function buildResyncTicketCountersSql(scoped: boolean): string {
  const companyFilter = scoped ? 'company_id = $1' : null;

  const selects = TICKET_COUNTER_SOURCES.map((src) => {
    const conditions = [companyFilter, src.where].filter((c): c is string => c !== null);
    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    return `
      SELECT company_id,
             '${src.type}'::ticket_setting_type AS ticket_type,
             max(${maxNumericSegmentSql(src.table, src.column)}) AS n
        FROM ${src.table}
        ${whereClause}
       GROUP BY company_id`;
  });

  // El GROUP BY externo colapsa las fuentes que comparten (company, tipo) —hoy
  // ninguna, pero mantiene el UPDATE con una sola fila por par, que es lo que
  // exige `UPDATE ... FROM` para ser determinista.
  return `
    WITH emitted AS (${selects.join('\n      UNION ALL')}
    ),
    maxes AS (
      SELECT company_id, ticket_type, max(n) AS n
        FROM emitted
       WHERE n IS NOT NULL
       GROUP BY company_id, ticket_type
    ),
    updated AS (
      UPDATE ticket_settings ts
         SET current_number = maxes.n,
             updated_at = now()
        FROM maxes
       WHERE ts.company_id = maxes.company_id
         AND ts.ticket_type = maxes.ticket_type
         AND maxes.n > ts.current_number
      RETURNING ts.company_id, ts.ticket_type, ts.current_number
    )
    SELECT company_id, ticket_type, current_number FROM updated`;
}

/** Contador adelantado por la resincronización. */
export interface ResyncedCounter {
  company_id: string;
  ticket_type: TicketSettingType;
  current_number: number;
}

/**
 * Resincroniza los contadores de UNA company. Recibe `EntityManager` (no
 * `DataSource`) para correr DENTRO de la transacción del caller: si el import
 * hace rollback, la resincronización se deshace con él.
 *
 * Devuelve los contadores que se adelantaron (vacío = ya estaban al día).
 */
export async function resyncTicketCounters(
  manager: EntityManager,
  companyId: number,
): Promise<ResyncedCounter[]> {
  return manager.query<ResyncedCounter[]>(buildResyncTicketCountersSql(true), [String(companyId)]);
}
