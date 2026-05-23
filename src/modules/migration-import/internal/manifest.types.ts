/**
 * Tipos del manifest emitido por el migrador placepos (`cloudMigration/buildZip.ts`).
 * Mantienen paridad byte-por-byte con el ZIP producido en el desktop client.
 *
 * Cualquier divergencia se rechaza en pre-flight (version != 1 o
 * target != 'pos_api_cloud').
 */

export interface MigrationManifest {
  version: number;
  target: 'pos_api_cloud';
  name: string;
  generated_at: string;
  generated_by: { id: string; full_name: string };
  source: {
    mongo_company_id: string;
    owner_email: string;
  };
  tables: Array<{ name: string; entity: string; count: number }>;
  warnings: string[];
}

/**
 * Lista exhaustiva de tablas que aparecen en `data/*.json` del ZIP.
 * Las que no traen datos en el dump van con array vacío.
 */
export const ZIP_TABLE_NAMES = [
  'companies',
  'users',
  'employees',
  'categories',
  'packagings',
  'products',
  'product_prices',
  'customers',
  'suppliers',
  'banks',
  'carriers',
  'sale_invoices',
  'sale_invoice_lines',
  'sale_payments',
  'purchases',
  'purchase_lines',
  'purchase_payments',
  'expenses',
  'credit_notes',
  'ticket_settings',
  'wallets',
  'cash_registers',
  'cash_register_logs',
  'financial_movements',
  'sale_credits',
  'purchase_credits',
  'carrier_credits',
  'carrier_payments',
  'credit_note_lines',
  'correction_sources',
  'inventory_movements',
  'product_cost_history',
  'product_price_history',
  'fixed_expenses',
  'fixed_expense_periods',
  'app_settings',
  'alert_configs',
  'app_alerts',
] as const;

export type ZipTableName = (typeof ZIP_TABLE_NAMES)[number];

/**
 * Fila genérica del ZIP. Los transformers emiten objetos con strings para
 * bigint y numbers redondeados para decimales. Los reusamos passthrough.
 */
export type ZipRow = Record<string, unknown>;

/**
 * Estructura resultante de leer el ZIP en memoria. Cada tabla viene con un
 * array de filas (potencialmente vacío).
 */
export interface ParsedZip {
  manifest: MigrationManifest;
  tables: Map<ZipTableName, ZipRow[]>;
}

/**
 * Modulos seleccionables del request body. Cada uno agrupa un conjunto de
 * tablas relacionadas. `catalog` es prerequisito implícito de `sales` y
 * `purchases`; `suppliers` lo es de `purchases`.
 */
export const SELECTABLE_MODULES = [
  'catalog',
  'customers',
  'suppliers',
  'employees',
  'sales',
  'purchases',
  'expenses',
] as const;

export type SelectableModule = (typeof SELECTABLE_MODULES)[number];
