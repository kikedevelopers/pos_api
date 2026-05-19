import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Backfill correctivo de `ticket_settings.prefix`.
 *
 * --------------------------------------------------------------------------
 * Por qué existe esta migración
 * --------------------------------------------------------------------------
 *
 * Hasta antes de este fix, `CreateDefaultTicketSettingsAction` sembraba las
 * 5 filas de configuración con `prefix = NULL` y `suffix = NULL`. El renderer
 * del cliente PlacePos asume que `ticket_number` SIEMPRE viene con prefijo
 * (espejo del seed local `seedEssentials.ts` que usa `PED-MAC`, `VEN-MAC`,
 * etc.) — sin prefix la UI muestra solo el padded number y los pedidos
 * quedan sin identificador legible para el usuario.
 *
 * El fix correctivo tiene DOS partes:
 *
 *   1. `CreateDefaultTicketSettingsAction` ahora siembra prefix canónicos
 *      (PED, VTA, NC, ND, COMP) para companies nuevas.
 *
 *   2. ESTA migración hace backfill para companies registradas antes del
 *      fix:
 *      (a) Si una company no tiene las 5 filas de `ticket_settings`
 *          (defensa: nunca debería pasar pero migraciones futuras pueden
 *          añadir tipos nuevos), inserta las faltantes con `prefix` canónico
 *          y `current_number = 0`.
 *      (b) Si una company SÍ tiene las filas pero con `prefix = NULL`,
 *          actualiza solo esas filas al prefix canónico — preservando filas
 *          donde el owner ya configuró un prefix personalizado vía
 *          `PUT /ticket-settings/:ticket_type`.
 *
 * --------------------------------------------------------------------------
 * Reversibilidad
 * --------------------------------------------------------------------------
 *
 * El `down` solo revierte las filas que ESTA migración actualizó a NULL —
 * NO borra filas existentes porque podrían tener numeración emitida en
 * producción. La detección del "lo cambió esta migración" se hace por
 * coincidencia del prefix canónico (PED/VTA/NC/ND/COMP) y `current_number = 0`.
 * Es una heurística — si el rollback fuera crítico, mejor restaurar desde
 * backup.
 *
 * --------------------------------------------------------------------------
 * Idempotencia
 * --------------------------------------------------------------------------
 *
 * Aplicar dos veces es seguro: el UPDATE filtra `prefix IS NULL`, el INSERT
 * filtra contra el UNIQUE `(company_id, ticket_type)` vía `ON CONFLICT`.
 */
export class BackfillTicketSettingsPrefixes1747010580000 implements MigrationInterface {
  name = 'BackfillTicketSettingsPrefixes1747010580000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const canonicalPrefixes: Array<{ type: string; prefix: string }> = [
      { type: 'ORDER', prefix: 'PED' },
      { type: 'SALE', prefix: 'VTA' },
      { type: 'CREDIT_NOTE', prefix: 'NC' },
      { type: 'DEBIT_NOTE', prefix: 'ND' },
      { type: 'PURCHASE', prefix: 'COMP' },
    ];

    // (a) INSERT de filas faltantes. `ON CONFLICT (company_id, ticket_type)
    //     DO NOTHING` apoyado en `idx_ticket_settings_company_type_unique`.
    //     Para companies que ya tienen las 5 filas, este INSERT es no-op.
    for (const { type, prefix } of canonicalPrefixes) {
      await queryRunner.query(
        `
        INSERT INTO ticket_settings (company_id, ticket_type, current_number, prefix, suffix)
        SELECT c.id, $1::ticket_setting_type, 0, $2, NULL
        FROM companies c
        ON CONFLICT (company_id, ticket_type) DO NOTHING
        `,
        [type, prefix],
      );
    }

    // (b) UPDATE de filas existentes que aún tienen prefix NULL — NO toca
    //     filas donde el owner ya configuró su propio prefix.
    for (const { type, prefix } of canonicalPrefixes) {
      await queryRunner.query(
        `
        UPDATE ticket_settings
        SET prefix = $2, updated_at = now()
        WHERE ticket_type = $1::ticket_setting_type
          AND prefix IS NULL
        `,
        [type, prefix],
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const canonicalPrefixes: Array<{ type: string; prefix: string }> = [
      { type: 'ORDER', prefix: 'PED' },
      { type: 'SALE', prefix: 'VTA' },
      { type: 'CREDIT_NOTE', prefix: 'NC' },
      { type: 'DEBIT_NOTE', prefix: 'ND' },
      { type: 'PURCHASE', prefix: 'COMP' },
    ];

    // Solo revertimos filas que (1) tengan el prefix canónico y (2) aún
    // estén en `current_number = 0` — es decir, que nunca emitieron un
    // folio. Las que ya emitieron, dejan el prefix canónico (preserva
    // legibilidad histórica) — no las pisamos porque su prefix forma parte
    // del ticket_number ya entregado al usuario.
    for (const { type, prefix } of canonicalPrefixes) {
      await queryRunner.query(
        `
        UPDATE ticket_settings
        SET prefix = NULL, updated_at = now()
        WHERE ticket_type = $1::ticket_setting_type
          AND prefix = $2
          AND current_number = 0
        `,
        [type, prefix],
      );
    }
  }
}
