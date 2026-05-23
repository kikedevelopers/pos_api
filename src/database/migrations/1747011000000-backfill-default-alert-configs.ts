import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Backfill de `alert_configs` para companies registradas ANTES de que
 * `RegisterAction` empezara a invocar `CreateDefaultAlertConfigsAction`
 * (migración previa: 1747010980000 / commit posterior al deploy inicial).
 *
 * Sin esta data los endpoints `GET /alert-configs/INACTIVE_CUSTOMER` y
 * `GET /app-alerts` devuelven 404 para esas companies y el tab "Alertas"
 * del cliente Electron muestra "No se pudo cargar la configuración".
 *
 * Inserta una fila `INACTIVE_CUSTOMER` (disabled por defecto) por cada
 * `companies.id` que no tenga ya esa config. `ON CONFLICT (company_id, type)
 * DO NOTHING` cubre la idempotencia ante re-runs y races con
 * `RegisterAction` (en caso de que una company nueva entre justo cuando
 * corre el backfill).
 *
 * Defaults espejo del seed placepos (`alertConfigs.ts`):
 *   - check_time: '07:00:00' (dentro del jsonb `config` porque la entidad de
 *     pos_api no tiene columna `check_time`).
 *   - params: { inactivity_days: 15, min_purchases: 3,
 *               recurrence_window_days: 60 }.
 */
export class BackfillDefaultAlertConfigs1747011000000 implements MigrationInterface {
  name = 'BackfillDefaultAlertConfigs1747011000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      INSERT INTO alert_configs (company_id, type, enabled, threshold, config)
      SELECT
        c.id,
        'INACTIVE_CUSTOMER',
        false,
        NULL,
        '{"check_time":"07:00:00","inactivity_days":15,"min_purchases":3,"recurrence_window_days":60}'::jsonb
      FROM companies c
      WHERE NOT EXISTS (
        SELECT 1 FROM alert_configs ac
        WHERE ac.company_id = c.id AND ac.type = 'INACTIVE_CUSTOMER'
      )
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Best-effort: borra solo las filas que coinciden con los defaults exactos
    // (si el usuario ya las modificó, no las tocamos).
    await queryRunner.query(`
      DELETE FROM alert_configs
      WHERE type = 'INACTIVE_CUSTOMER'
        AND enabled = false
        AND threshold IS NULL
        AND config = '{"check_time":"07:00:00","inactivity_days":15,"min_purchases":3,"recurrence_window_days":60}'::jsonb
    `);
  }
}
