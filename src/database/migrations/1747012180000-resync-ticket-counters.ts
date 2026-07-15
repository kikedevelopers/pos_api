import type { MigrationInterface, QueryRunner } from 'typeorm';

import { buildResyncTicketCountersSql } from '@/modules/ticket-settings/internal/resync-ticket-counters';

/**
 * Backfill correctivo de `ticket_settings.current_number`.
 *
 * --------------------------------------------------------------------------
 * Por qué existe esta migración
 * --------------------------------------------------------------------------
 *
 * `ImportTenantAction` (respaldo/importación por tenant desde kdevs) REEMPLAZA
 * la data de negocio del destino con la del respaldo —incluidas las
 * `sale_invoices` con sus `ticket_number` originales— pero CONSERVA los
 * `ticket_settings` del destino (están en `PRESERVED_TABLES` para no pisar el
 * prefix/suffix que configuró el owner). Hasta el fix que acompaña a esta
 * migración, el contador NO se resincronizaba con los folios importados, así
 * que quedaba apuntando a números YA OCUPADOS.
 *
 * Consecuencia en la company afectada: la siguiente venta pide un folio
 * existente y revienta con 23505 sobre
 * `idx_sale_invoices_company_ticket_number_unique` →
 * `SALE_TICKET_NUMBER_DUPLICATE` ("Folio de venta duplicado"). El bloqueo es
 * PERMANENTE, no transitorio: el incremento del contador vive dentro de la
 * transacción de la venta, así que el rollback lo deshace y cada reintento
 * vuelve a pedir el MISMO folio ocupado. El POS queda inutilizable.
 *
 * El fix de raíz vive en `ImportTenantAction` (resincroniza al final del
 * import). Esta migración cura las companies que YA quedaron desincronizadas.
 *
 * --------------------------------------------------------------------------
 * Qué hace exactamente
 * --------------------------------------------------------------------------
 *
 * Corre `buildResyncTicketCountersSql(false)` —el MISMO SQL que usa el import,
 * sin acotar a una company— que sube cada contador al folio más alto realmente
 * emitido en su tabla fuente. Solo ADELANTA contadores (`n > current_number`):
 * las companies sanas no se tocan, y correrla dos veces no cambia nada
 * (idempotente).
 *
 * --------------------------------------------------------------------------
 * Reversibilidad
 * --------------------------------------------------------------------------
 *
 * `down` es un no-op DELIBERADO. Revertir significaría devolver los contadores
 * a un estado que produce folios duplicados —restaurar el bug—, y además el
 * valor previo no se puede reconstruir (no se guarda en ningún lado). No bajar
 * un contador es siempre seguro: a lo sumo se saltan números.
 */
export class ResyncTicketCounters1747012180000 implements MigrationInterface {
  name = 'ResyncTicketCounters1747012180000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(buildResyncTicketCountersSql(false));
  }

  public async down(): Promise<void> {
    // No-op: ver "Reversibilidad" arriba.
  }
}
