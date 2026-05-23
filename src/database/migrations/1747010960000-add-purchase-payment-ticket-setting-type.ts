import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Agrega el valor `PURCHASE_PAYMENT` al enum Postgres `ticket_setting_type`.
 *
 * Paridad placepos (`enums/TicketSettingType.ts` lo declara como 6to valor)
 * y `seedEssentials.ts` lo seedea con prefix `APC-MAC`. pos_api solo tenía
 * los 5 originales — sin este valor el seed `CreateDefaultTicketSettingsAction`
 * no puede insertar la fila para registros nuevos, y los pagos a proveedores
 * no obtienen folio.
 *
 * Notas operacionales:
 *
 * 1. `ALTER TYPE ... ADD VALUE` en PostgreSQL ≥ 12 funciona DENTRO de
 *    transacciones (en versiones anteriores fallaba). El runner de TypeORM
 *    envuelve cada migración en `BEGIN/COMMIT`, así que aquí va bien.
 *
 * 2. Las companies EXISTENTES no obtienen la fila automáticamente — no hay
 *    backfill aquí porque queremos preservar la idempotencia del UNIQUE
 *    `(company_id, ticket_type)`. Si una company existente necesita el
 *    folio, el endpoint `IncrementTicketNumberAction` ya inserta on-demand
 *    cuando la fila falta. Las companies NUEVAS sí lo reciben en el seed.
 *
 * 3. `DOWN` no es soportado en PostgreSQL — no existe `ALTER TYPE ... DROP
 *    VALUE`. La única forma sería recrear el enum entero. Lo dejamos como
 *    no-op explícito y documentado.
 */
export class AddPurchasePaymentTicketSettingType1747010960000 implements MigrationInterface {
  name = 'AddPurchasePaymentTicketSettingType1747010960000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // IF NOT EXISTS protege idempotencia ante re-runs (no es estándar SQL
    // pero PostgreSQL lo soporta para enums desde la 9.6).
    await queryRunner.query(`
      ALTER TYPE ticket_setting_type ADD VALUE IF NOT EXISTS 'PURCHASE_PAYMENT'
    `);
  }

  public async down(): Promise<void> {
    // PostgreSQL no soporta DROP VALUE en un enum. La operación inversa
    // requeriría recrear el tipo completo (rename, create new, swap, drop).
    // No vale la pena el riesgo — esta migración es de schema, no reversible.
    throw new Error(
      'PostgreSQL no soporta ALTER TYPE ... DROP VALUE. Esta migración no es reversible.',
    );
  }
}
