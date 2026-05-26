import type { ZipTableName } from './manifest.types';
import type { SelectableModule } from './manifest.types';

/**
 * Orden topológico fijo de inserción para los módulos seleccionables.
 *
 * `companies` y `users` se insertan antes de iniciar el bucle de módulos
 * (deben existir para que cualquier FK `company_id` / `created_by_id`
 * resuelva). Los seeds default (ticket_settings, wallet, cash_register,
 * app_settings, alert_configs) van entre user-insert y módulos.
 *
 * Dentro de cada módulo, las tablas se procesan en este orden estricto:
 *   - categories ANTES de products (FK).
 *   - packagings ANTES de products (FK).
 *   - products ANTES de product_prices (FK).
 *   - banks/carriers ANTES de suppliers (no hay FK directa pero se mantienen
 *     en el módulo `suppliers`).
 *   - sale_invoices ANTES de sale_invoice_lines / sale_payments (FK).
 *   - credit_notes ANTES de credit_note_lines (FK).
 *   - purchases ANTES de purchase_lines / purchase_payments (FK).
 *   - expenses ANTES de fixed_expenses; fixed_expenses ANTES de
 *     fixed_expense_periods (FK fixed_expense_id).
 *   - delivery_companies ANTES de deliveries (FK delivery_company_id).
 *   - inventory_movements al final: sus refs cruzan products/sales/purchases.
 */
export const MODULE_INSERT_ORDER: Record<SelectableModule, ZipTableName[]> = {
  catalog: ['categories', 'packagings', 'products', 'product_prices'],
  customers: ['customers'],
  suppliers: ['banks', 'carriers', 'suppliers'],
  employees: ['employees'],
  sales: [
    'sale_invoices',
    'sale_invoice_lines',
    'sale_payments',
    'credit_notes',
    'credit_note_lines',
  ],
  purchases: ['purchases', 'purchase_lines', 'purchase_payments'],
  expenses: ['expenses', 'fixed_expenses', 'fixed_expense_periods'],
  deliveries: ['delivery_companies', 'deliveries'],
  inventory: ['inventory_movements'],
};

/**
 * Orden global de procesamiento de módulos. `suppliers` antes que
 * `purchases` (deps), `catalog` antes que `sales` y `purchases`.
 *
 * `deliveries` va DESPUÉS de `sales` (su `invoice_id` remapea contra
 * `sale_invoices`). `inventory` va AL FINAL: `inventory_movements` referencia
 * `products` (catalog) y, vía `reference_type`, ventas y compras.
 */
export const MODULE_GLOBAL_ORDER: SelectableModule[] = [
  'catalog',
  'customers',
  'suppliers',
  'employees',
  'sales',
  'purchases',
  'expenses',
  'deliveries',
  'inventory',
];
