import type { SelectableModule, ZipTableName } from './manifest.types';

/**
 * Mapeo de cada módulo a las tablas que sus datos pueblan. Las tablas que
 * siempre se insertan (companies, users) o se siembran como defaults
 * (ticket_settings, wallets, cash_registers, app_settings, alert_configs)
 * NO viven aquí — son responsabilidad del action principal.
 */
const MODULE_TABLES: Record<SelectableModule, ZipTableName[]> = {
  catalog: ['categories', 'packagings', 'products', 'product_prices'],
  customers: ['customers'],
  suppliers: ['suppliers', 'banks', 'carriers'],
  employees: ['employees'],
  sales: [
    'sale_invoices',
    'sale_invoice_lines',
    'sale_payments',
    'credit_notes',
    'credit_note_lines',
  ],
  purchases: ['purchases', 'purchase_lines', 'purchase_payments'],
  expenses: ['expenses'],
};

/**
 * Dependencias modulares. Si llega `sales` agregamos `catalog`. Si llega
 * `purchases` agregamos `catalog` + `suppliers`.
 */
const MODULE_DEPS: Record<SelectableModule, SelectableModule[]> = {
  catalog: [],
  customers: [],
  suppliers: [],
  employees: [],
  sales: ['catalog'],
  purchases: ['catalog', 'suppliers'],
  expenses: [],
};

/**
 * Resuelve la lista final de módulos a importar incluyendo dependencias
 * transitivas. Mantiene el orden topológico (deps antes de dependientes).
 */
export function resolveSelectedModules(input: SelectableModule[]): SelectableModule[] {
  const resolved = new Set<SelectableModule>();
  const visiting = new Set<SelectableModule>();

  const visit = (mod: SelectableModule): void => {
    if (resolved.has(mod) || visiting.has(mod)) {
      return;
    }
    visiting.add(mod);
    for (const dep of MODULE_DEPS[mod]) {
      visit(dep);
    }
    visiting.delete(mod);
    resolved.add(mod);
  };

  for (const mod of input) {
    visit(mod);
  }
  return Array.from(resolved);
}

/**
 * Devuelve las tablas que el módulo solicita poblar.
 */
export function tablesForModule(mod: SelectableModule): ZipTableName[] {
  return MODULE_TABLES[mod];
}
