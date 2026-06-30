import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Habilita el barrido total de un tenant al borrar su `company`.
 *
 * - Todas las FKs `company_id` pasan de RESTRICT a ON DELETE CASCADE: borrar
 *   la company elimina en cascada absolutamente todos sus datos (ventas,
 *   compras, clientes, usuarios, suscripción, etc.), como si nunca hubiera
 *   existido.
 * - Las FKs intra-tenant que eran RESTRICT pasan a NO ACTION: NO ACTION se
 *   verifica al FINAL del statement, así la cascada desde `companies` no
 *   choca con un RESTRICT inmediato, pero se mantiene la protección contra
 *   borrados sueltos inválidos en la operación normal (un producto con
 *   ventas sigue sin poder borrarse aisladamente).
 *
 * Generada por introspección del catálogo (pg_get_constraintdef), preserva
 * columnas y ON UPDATE de cada FK; solo cambia ON DELETE.
 */
export class EnableTenantCascadeDelete1747011300000 implements MigrationInterface {
  name = 'EnableTenantCascadeDelete1747011300000';

  private readonly forward: string[] = [
    `ALTER TABLE public.alert_configs DROP CONSTRAINT fk_alert_configs_company_id, ADD CONSTRAINT fk_alert_configs_company_id FOREIGN KEY (company_id) REFERENCES companies(id) ON UPDATE CASCADE ON DELETE CASCADE;`,
    `ALTER TABLE public.app_alerts DROP CONSTRAINT fk_app_alerts_company_id, ADD CONSTRAINT fk_app_alerts_company_id FOREIGN KEY (company_id) REFERENCES companies(id) ON UPDATE CASCADE ON DELETE CASCADE;`,
    `ALTER TABLE public.app_settings DROP CONSTRAINT fk_app_settings_company_id, ADD CONSTRAINT fk_app_settings_company_id FOREIGN KEY (company_id) REFERENCES companies(id) ON UPDATE CASCADE ON DELETE CASCADE;`,
    `ALTER TABLE public.banks DROP CONSTRAINT fk_banks_company_id, ADD CONSTRAINT fk_banks_company_id FOREIGN KEY (company_id) REFERENCES companies(id) ON UPDATE CASCADE ON DELETE CASCADE;`,
    `ALTER TABLE public.carrier_credits DROP CONSTRAINT fk_carrier_credits_company_id, ADD CONSTRAINT fk_carrier_credits_company_id FOREIGN KEY (company_id) REFERENCES companies(id) ON UPDATE CASCADE ON DELETE CASCADE;`,
    `ALTER TABLE public.carrier_payments DROP CONSTRAINT fk_carrier_payments_company_id, ADD CONSTRAINT fk_carrier_payments_company_id FOREIGN KEY (company_id) REFERENCES companies(id) ON UPDATE CASCADE ON DELETE CASCADE;`,
    `ALTER TABLE public.carriers DROP CONSTRAINT fk_carriers_company_id, ADD CONSTRAINT fk_carriers_company_id FOREIGN KEY (company_id) REFERENCES companies(id) ON UPDATE CASCADE ON DELETE CASCADE;`,
    `ALTER TABLE public.cash_register_logs DROP CONSTRAINT fk_cash_register_logs_company_id, ADD CONSTRAINT fk_cash_register_logs_company_id FOREIGN KEY (company_id) REFERENCES companies(id) ON UPDATE CASCADE ON DELETE CASCADE;`,
    `ALTER TABLE public.cash_registers DROP CONSTRAINT fk_cash_registers_company_id, ADD CONSTRAINT fk_cash_registers_company_id FOREIGN KEY (company_id) REFERENCES companies(id) ON UPDATE CASCADE ON DELETE CASCADE;`,
    `ALTER TABLE public.categories DROP CONSTRAINT fk_categories_company_id, ADD CONSTRAINT fk_categories_company_id FOREIGN KEY (company_id) REFERENCES companies(id) ON UPDATE CASCADE ON DELETE CASCADE;`,
    `ALTER TABLE public.correction_sources DROP CONSTRAINT fk_correction_sources_company_id, ADD CONSTRAINT fk_correction_sources_company_id FOREIGN KEY (company_id) REFERENCES companies(id) ON UPDATE CASCADE ON DELETE CASCADE;`,
    `ALTER TABLE public.credit_note_lines DROP CONSTRAINT fk_credit_note_lines_company_id, ADD CONSTRAINT fk_credit_note_lines_company_id FOREIGN KEY (company_id) REFERENCES companies(id) ON UPDATE CASCADE ON DELETE CASCADE;`,
    `ALTER TABLE public.credit_notes DROP CONSTRAINT fk_credit_notes_company_id, ADD CONSTRAINT fk_credit_notes_company_id FOREIGN KEY (company_id) REFERENCES companies(id) ON UPDATE CASCADE ON DELETE CASCADE;`,
    `ALTER TABLE public.customers DROP CONSTRAINT fk_customers_company_id, ADD CONSTRAINT fk_customers_company_id FOREIGN KEY (company_id) REFERENCES companies(id) ON UPDATE CASCADE ON DELETE CASCADE;`,
    `ALTER TABLE public.deliveries DROP CONSTRAINT fk_deliveries_company_id, ADD CONSTRAINT fk_deliveries_company_id FOREIGN KEY (company_id) REFERENCES companies(id) ON UPDATE CASCADE ON DELETE CASCADE;`,
    `ALTER TABLE public.delivery_companies DROP CONSTRAINT fk_delivery_companies_company_id, ADD CONSTRAINT fk_delivery_companies_company_id FOREIGN KEY (company_id) REFERENCES companies(id) ON UPDATE CASCADE ON DELETE CASCADE;`,
    `ALTER TABLE public.employees DROP CONSTRAINT fk_employees_company_id, ADD CONSTRAINT fk_employees_company_id FOREIGN KEY (company_id) REFERENCES companies(id) ON UPDATE CASCADE ON DELETE CASCADE;`,
    `ALTER TABLE public.expenses DROP CONSTRAINT fk_expenses_company_id, ADD CONSTRAINT fk_expenses_company_id FOREIGN KEY (company_id) REFERENCES companies(id) ON UPDATE CASCADE ON DELETE CASCADE;`,
    `ALTER TABLE public.financial_movements DROP CONSTRAINT fk_financial_movements_company_id, ADD CONSTRAINT fk_financial_movements_company_id FOREIGN KEY (company_id) REFERENCES companies(id) ON UPDATE CASCADE ON DELETE CASCADE;`,
    `ALTER TABLE public.fixed_expense_periods DROP CONSTRAINT fk_fixed_expense_periods_company_id, ADD CONSTRAINT fk_fixed_expense_periods_company_id FOREIGN KEY (company_id) REFERENCES companies(id) ON UPDATE CASCADE ON DELETE CASCADE;`,
    `ALTER TABLE public.fixed_expenses DROP CONSTRAINT fk_fixed_expenses_company_id, ADD CONSTRAINT fk_fixed_expenses_company_id FOREIGN KEY (company_id) REFERENCES companies(id) ON UPDATE CASCADE ON DELETE CASCADE;`,
    `ALTER TABLE public.inventory_movements DROP CONSTRAINT inventory_movements_company_id_fkey, ADD CONSTRAINT inventory_movements_company_id_fkey FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE;`,
    `ALTER TABLE public.packagings DROP CONSTRAINT fk_packagings_company_id, ADD CONSTRAINT fk_packagings_company_id FOREIGN KEY (company_id) REFERENCES companies(id) ON UPDATE CASCADE ON DELETE CASCADE;`,
    `ALTER TABLE public.product_cost_history DROP CONSTRAINT fk_pch_company_id, ADD CONSTRAINT fk_pch_company_id FOREIGN KEY (company_id) REFERENCES companies(id) ON UPDATE CASCADE ON DELETE CASCADE;`,
    `ALTER TABLE public.product_price_history DROP CONSTRAINT fk_pph_company_id, ADD CONSTRAINT fk_pph_company_id FOREIGN KEY (company_id) REFERENCES companies(id) ON UPDATE CASCADE ON DELETE CASCADE;`,
    `ALTER TABLE public.product_prices DROP CONSTRAINT fk_product_prices_company_id, ADD CONSTRAINT fk_product_prices_company_id FOREIGN KEY (company_id) REFERENCES companies(id) ON UPDATE CASCADE ON DELETE CASCADE;`,
    `ALTER TABLE public.products DROP CONSTRAINT fk_products_company_id, ADD CONSTRAINT fk_products_company_id FOREIGN KEY (company_id) REFERENCES companies(id) ON UPDATE CASCADE ON DELETE CASCADE;`,
    `ALTER TABLE public.purchase_credits DROP CONSTRAINT fk_purchase_credits_company_id, ADD CONSTRAINT fk_purchase_credits_company_id FOREIGN KEY (company_id) REFERENCES companies(id) ON UPDATE CASCADE ON DELETE CASCADE;`,
    `ALTER TABLE public.purchase_lines DROP CONSTRAINT fk_purchase_lines_company_id, ADD CONSTRAINT fk_purchase_lines_company_id FOREIGN KEY (company_id) REFERENCES companies(id) ON UPDATE CASCADE ON DELETE CASCADE;`,
    `ALTER TABLE public.purchase_payments DROP CONSTRAINT fk_purchase_payments_company_id, ADD CONSTRAINT fk_purchase_payments_company_id FOREIGN KEY (company_id) REFERENCES companies(id) ON UPDATE CASCADE ON DELETE CASCADE;`,
    `ALTER TABLE public.purchases DROP CONSTRAINT fk_purchases_company_id, ADD CONSTRAINT fk_purchases_company_id FOREIGN KEY (company_id) REFERENCES companies(id) ON UPDATE CASCADE ON DELETE CASCADE;`,
    `ALTER TABLE public.sale_credits DROP CONSTRAINT fk_sale_credits_company_id, ADD CONSTRAINT fk_sale_credits_company_id FOREIGN KEY (company_id) REFERENCES companies(id) ON UPDATE CASCADE ON DELETE CASCADE;`,
    `ALTER TABLE public.sale_invoice_lines DROP CONSTRAINT fk_sale_invoice_lines_company_id, ADD CONSTRAINT fk_sale_invoice_lines_company_id FOREIGN KEY (company_id) REFERENCES companies(id) ON UPDATE CASCADE ON DELETE CASCADE;`,
    `ALTER TABLE public.sale_invoices DROP CONSTRAINT fk_sale_invoices_company_id, ADD CONSTRAINT fk_sale_invoices_company_id FOREIGN KEY (company_id) REFERENCES companies(id) ON UPDATE CASCADE ON DELETE CASCADE;`,
    `ALTER TABLE public.sale_payments DROP CONSTRAINT fk_sale_payments_company_id, ADD CONSTRAINT fk_sale_payments_company_id FOREIGN KEY (company_id) REFERENCES companies(id) ON UPDATE CASCADE ON DELETE CASCADE;`,
    `ALTER TABLE public.suppliers DROP CONSTRAINT fk_suppliers_company_id, ADD CONSTRAINT fk_suppliers_company_id FOREIGN KEY (company_id) REFERENCES companies(id) ON UPDATE CASCADE ON DELETE CASCADE;`,
    `ALTER TABLE public.ticket_settings DROP CONSTRAINT fk_ticket_settings_company_id, ADD CONSTRAINT fk_ticket_settings_company_id FOREIGN KEY (company_id) REFERENCES companies(id) ON UPDATE CASCADE ON DELETE CASCADE;`,
    `ALTER TABLE public.users DROP CONSTRAINT fk_users_company_id, ADD CONSTRAINT fk_users_company_id FOREIGN KEY (company_id) REFERENCES companies(id) ON UPDATE CASCADE ON DELETE CASCADE;`,
    `ALTER TABLE public.wallets DROP CONSTRAINT fk_wallets_company_id, ADD CONSTRAINT fk_wallets_company_id FOREIGN KEY (company_id) REFERENCES companies(id) ON UPDATE CASCADE ON DELETE CASCADE;`,
    `ALTER TABLE public.carrier_credits DROP CONSTRAINT fk_carrier_credits_carrier_id, ADD CONSTRAINT fk_carrier_credits_carrier_id FOREIGN KEY (carrier_id) REFERENCES carriers(id) ON UPDATE CASCADE ON DELETE NO ACTION;`,
    `ALTER TABLE public.carrier_credits DROP CONSTRAINT fk_carrier_credits_purchase_id, ADD CONSTRAINT fk_carrier_credits_purchase_id FOREIGN KEY (purchase_id) REFERENCES purchases(id) ON UPDATE CASCADE ON DELETE NO ACTION;`,
    `ALTER TABLE public.carrier_payments DROP CONSTRAINT fk_carrier_payments_wallet_id, ADD CONSTRAINT fk_carrier_payments_wallet_id FOREIGN KEY (wallet_id) REFERENCES wallets(id) ON UPDATE CASCADE ON DELETE NO ACTION;`,
    `ALTER TABLE public.carrier_payments DROP CONSTRAINT fk_carrier_payments_credit_id, ADD CONSTRAINT fk_carrier_payments_credit_id FOREIGN KEY (carrier_credit_id) REFERENCES carrier_credits(id) ON UPDATE CASCADE ON DELETE NO ACTION;`,
    `ALTER TABLE public.carrier_payments DROP CONSTRAINT fk_carrier_payments_bank_id, ADD CONSTRAINT fk_carrier_payments_bank_id FOREIGN KEY (bank_id) REFERENCES banks(id) ON UPDATE CASCADE ON DELETE NO ACTION;`,
    `ALTER TABLE public.carrier_payments DROP CONSTRAINT fk_carrier_payments_fm_id, ADD CONSTRAINT fk_carrier_payments_fm_id FOREIGN KEY (financial_movement_id) REFERENCES financial_movements(id) ON UPDATE CASCADE ON DELETE NO ACTION;`,
    `ALTER TABLE public.cash_register_logs DROP CONSTRAINT fk_cash_register_logs_cash_register_id, ADD CONSTRAINT fk_cash_register_logs_cash_register_id FOREIGN KEY (cash_register_id) REFERENCES cash_registers(id) ON UPDATE CASCADE ON DELETE NO ACTION;`,
    `ALTER TABLE public.credit_note_lines DROP CONSTRAINT fk_credit_note_lines_packaging_id, ADD CONSTRAINT fk_credit_note_lines_packaging_id FOREIGN KEY (packaging_id) REFERENCES packagings(id) ON UPDATE CASCADE ON DELETE NO ACTION;`,
    `ALTER TABLE public.credit_note_lines DROP CONSTRAINT fk_credit_note_lines_product_id, ADD CONSTRAINT fk_credit_note_lines_product_id FOREIGN KEY (product_id) REFERENCES products(id) ON UPDATE CASCADE ON DELETE NO ACTION;`,
    `ALTER TABLE public.credit_notes DROP CONSTRAINT fk_credit_notes_sale_invoice_id, ADD CONSTRAINT fk_credit_notes_sale_invoice_id FOREIGN KEY (sale_invoice_id) REFERENCES sale_invoices(id) ON UPDATE CASCADE ON DELETE NO ACTION;`,
    `ALTER TABLE public.deliveries DROP CONSTRAINT fk_deliveries_delivery_company_id, ADD CONSTRAINT fk_deliveries_delivery_company_id FOREIGN KEY (delivery_company_id) REFERENCES delivery_companies(id) ON UPDATE CASCADE ON DELETE NO ACTION;`,
    `ALTER TABLE public.inventory_movements DROP CONSTRAINT inventory_movements_product_id_fkey, ADD CONSTRAINT inventory_movements_product_id_fkey FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE NO ACTION;`,
    `ALTER TABLE public.product_cost_history DROP CONSTRAINT fk_pch_product_id, ADD CONSTRAINT fk_pch_product_id FOREIGN KEY (product_id) REFERENCES products(id) ON UPDATE CASCADE ON DELETE NO ACTION;`,
    `ALTER TABLE public.product_price_history DROP CONSTRAINT fk_pph_product_price_id, ADD CONSTRAINT fk_pph_product_price_id FOREIGN KEY (product_price_id) REFERENCES product_prices(id) ON UPDATE CASCADE ON DELETE NO ACTION;`,
    `ALTER TABLE public.product_price_history DROP CONSTRAINT fk_pph_product_id, ADD CONSTRAINT fk_pph_product_id FOREIGN KEY (product_id) REFERENCES products(id) ON UPDATE CASCADE ON DELETE NO ACTION;`,
    `ALTER TABLE public.products DROP CONSTRAINT fk_products_parent_id, ADD CONSTRAINT fk_products_parent_id FOREIGN KEY (parent_id) REFERENCES products(id) ON UPDATE CASCADE ON DELETE NO ACTION;`,
    `ALTER TABLE public.purchase_credits DROP CONSTRAINT fk_purchase_credits_supplier_id, ADD CONSTRAINT fk_purchase_credits_supplier_id FOREIGN KEY (supplier_id) REFERENCES suppliers(id) ON UPDATE CASCADE ON DELETE NO ACTION;`,
    `ALTER TABLE public.purchase_lines DROP CONSTRAINT fk_purchase_lines_supplier_id, ADD CONSTRAINT fk_purchase_lines_supplier_id FOREIGN KEY (supplier_id) REFERENCES suppliers(id) ON UPDATE CASCADE ON DELETE NO ACTION;`,
    `ALTER TABLE public.purchase_lines DROP CONSTRAINT fk_purchase_lines_product_id, ADD CONSTRAINT fk_purchase_lines_product_id FOREIGN KEY (product_id) REFERENCES products(id) ON UPDATE CASCADE ON DELETE NO ACTION;`,
    `ALTER TABLE public.purchase_lines DROP CONSTRAINT fk_purchase_lines_packaging_id, ADD CONSTRAINT fk_purchase_lines_packaging_id FOREIGN KEY (packaging_id) REFERENCES packagings(id) ON UPDATE CASCADE ON DELETE NO ACTION;`,
    `ALTER TABLE public.purchases DROP CONSTRAINT fk_purchases_carrier_id, ADD CONSTRAINT fk_purchases_carrier_id FOREIGN KEY (carrier_id) REFERENCES carriers(id) ON UPDATE CASCADE ON DELETE NO ACTION;`,
    `ALTER TABLE public.purchases DROP CONSTRAINT fk_purchases_supplier_id, ADD CONSTRAINT fk_purchases_supplier_id FOREIGN KEY (supplier_id) REFERENCES suppliers(id) ON UPDATE CASCADE ON DELETE NO ACTION;`,
    `ALTER TABLE public.sale_credits DROP CONSTRAINT fk_sale_credits_customer_id, ADD CONSTRAINT fk_sale_credits_customer_id FOREIGN KEY (customer_id) REFERENCES customers(id) ON UPDATE CASCADE ON DELETE NO ACTION;`,
    `ALTER TABLE public.sale_invoice_lines DROP CONSTRAINT fk_sale_invoice_lines_packaging_id, ADD CONSTRAINT fk_sale_invoice_lines_packaging_id FOREIGN KEY (packaging_id) REFERENCES packagings(id) ON UPDATE CASCADE ON DELETE NO ACTION;`,
    `ALTER TABLE public.sale_invoice_lines DROP CONSTRAINT fk_sale_invoice_lines_product_price_id, ADD CONSTRAINT fk_sale_invoice_lines_product_price_id FOREIGN KEY (product_price_id) REFERENCES product_prices(id) ON UPDATE CASCADE ON DELETE NO ACTION;`,
    `ALTER TABLE public.sale_invoice_lines DROP CONSTRAINT fk_sale_invoice_lines_product_id, ADD CONSTRAINT fk_sale_invoice_lines_product_id FOREIGN KEY (product_id) REFERENCES products(id) ON UPDATE CASCADE ON DELETE NO ACTION;`,
  ];

  private readonly backward: string[] = [
    `ALTER TABLE public.alert_configs DROP CONSTRAINT fk_alert_configs_company_id, ADD CONSTRAINT fk_alert_configs_company_id FOREIGN KEY (company_id) REFERENCES companies(id) ON UPDATE CASCADE ON DELETE RESTRICT;`,
    `ALTER TABLE public.app_alerts DROP CONSTRAINT fk_app_alerts_company_id, ADD CONSTRAINT fk_app_alerts_company_id FOREIGN KEY (company_id) REFERENCES companies(id) ON UPDATE CASCADE ON DELETE RESTRICT;`,
    `ALTER TABLE public.app_settings DROP CONSTRAINT fk_app_settings_company_id, ADD CONSTRAINT fk_app_settings_company_id FOREIGN KEY (company_id) REFERENCES companies(id) ON UPDATE CASCADE ON DELETE RESTRICT;`,
    `ALTER TABLE public.banks DROP CONSTRAINT fk_banks_company_id, ADD CONSTRAINT fk_banks_company_id FOREIGN KEY (company_id) REFERENCES companies(id) ON UPDATE CASCADE ON DELETE RESTRICT;`,
    `ALTER TABLE public.carrier_credits DROP CONSTRAINT fk_carrier_credits_purchase_id, ADD CONSTRAINT fk_carrier_credits_purchase_id FOREIGN KEY (purchase_id) REFERENCES purchases(id) ON UPDATE CASCADE ON DELETE RESTRICT;`,
    `ALTER TABLE public.carrier_credits DROP CONSTRAINT fk_carrier_credits_carrier_id, ADD CONSTRAINT fk_carrier_credits_carrier_id FOREIGN KEY (carrier_id) REFERENCES carriers(id) ON UPDATE CASCADE ON DELETE RESTRICT;`,
    `ALTER TABLE public.carrier_credits DROP CONSTRAINT fk_carrier_credits_company_id, ADD CONSTRAINT fk_carrier_credits_company_id FOREIGN KEY (company_id) REFERENCES companies(id) ON UPDATE CASCADE ON DELETE RESTRICT;`,
    `ALTER TABLE public.carrier_payments DROP CONSTRAINT fk_carrier_payments_fm_id, ADD CONSTRAINT fk_carrier_payments_fm_id FOREIGN KEY (financial_movement_id) REFERENCES financial_movements(id) ON UPDATE CASCADE ON DELETE RESTRICT;`,
    `ALTER TABLE public.carrier_payments DROP CONSTRAINT fk_carrier_payments_credit_id, ADD CONSTRAINT fk_carrier_payments_credit_id FOREIGN KEY (carrier_credit_id) REFERENCES carrier_credits(id) ON UPDATE CASCADE ON DELETE RESTRICT;`,
    `ALTER TABLE public.carrier_payments DROP CONSTRAINT fk_carrier_payments_company_id, ADD CONSTRAINT fk_carrier_payments_company_id FOREIGN KEY (company_id) REFERENCES companies(id) ON UPDATE CASCADE ON DELETE RESTRICT;`,
    `ALTER TABLE public.carrier_payments DROP CONSTRAINT fk_carrier_payments_wallet_id, ADD CONSTRAINT fk_carrier_payments_wallet_id FOREIGN KEY (wallet_id) REFERENCES wallets(id) ON UPDATE CASCADE ON DELETE RESTRICT;`,
    `ALTER TABLE public.carrier_payments DROP CONSTRAINT fk_carrier_payments_bank_id, ADD CONSTRAINT fk_carrier_payments_bank_id FOREIGN KEY (bank_id) REFERENCES banks(id) ON UPDATE CASCADE ON DELETE RESTRICT;`,
    `ALTER TABLE public.carriers DROP CONSTRAINT fk_carriers_company_id, ADD CONSTRAINT fk_carriers_company_id FOREIGN KEY (company_id) REFERENCES companies(id) ON UPDATE CASCADE ON DELETE RESTRICT;`,
    `ALTER TABLE public.cash_register_logs DROP CONSTRAINT fk_cash_register_logs_company_id, ADD CONSTRAINT fk_cash_register_logs_company_id FOREIGN KEY (company_id) REFERENCES companies(id) ON UPDATE CASCADE ON DELETE RESTRICT;`,
    `ALTER TABLE public.cash_register_logs DROP CONSTRAINT fk_cash_register_logs_cash_register_id, ADD CONSTRAINT fk_cash_register_logs_cash_register_id FOREIGN KEY (cash_register_id) REFERENCES cash_registers(id) ON UPDATE CASCADE ON DELETE RESTRICT;`,
    `ALTER TABLE public.cash_registers DROP CONSTRAINT fk_cash_registers_company_id, ADD CONSTRAINT fk_cash_registers_company_id FOREIGN KEY (company_id) REFERENCES companies(id) ON UPDATE CASCADE ON DELETE RESTRICT;`,
    `ALTER TABLE public.categories DROP CONSTRAINT fk_categories_company_id, ADD CONSTRAINT fk_categories_company_id FOREIGN KEY (company_id) REFERENCES companies(id) ON UPDATE CASCADE ON DELETE RESTRICT;`,
    `ALTER TABLE public.correction_sources DROP CONSTRAINT fk_correction_sources_company_id, ADD CONSTRAINT fk_correction_sources_company_id FOREIGN KEY (company_id) REFERENCES companies(id) ON UPDATE CASCADE ON DELETE RESTRICT;`,
    `ALTER TABLE public.credit_note_lines DROP CONSTRAINT fk_credit_note_lines_company_id, ADD CONSTRAINT fk_credit_note_lines_company_id FOREIGN KEY (company_id) REFERENCES companies(id) ON UPDATE CASCADE ON DELETE RESTRICT;`,
    `ALTER TABLE public.credit_note_lines DROP CONSTRAINT fk_credit_note_lines_packaging_id, ADD CONSTRAINT fk_credit_note_lines_packaging_id FOREIGN KEY (packaging_id) REFERENCES packagings(id) ON UPDATE CASCADE ON DELETE RESTRICT;`,
    `ALTER TABLE public.credit_note_lines DROP CONSTRAINT fk_credit_note_lines_product_id, ADD CONSTRAINT fk_credit_note_lines_product_id FOREIGN KEY (product_id) REFERENCES products(id) ON UPDATE CASCADE ON DELETE RESTRICT;`,
    `ALTER TABLE public.credit_notes DROP CONSTRAINT fk_credit_notes_company_id, ADD CONSTRAINT fk_credit_notes_company_id FOREIGN KEY (company_id) REFERENCES companies(id) ON UPDATE CASCADE ON DELETE RESTRICT;`,
    `ALTER TABLE public.credit_notes DROP CONSTRAINT fk_credit_notes_sale_invoice_id, ADD CONSTRAINT fk_credit_notes_sale_invoice_id FOREIGN KEY (sale_invoice_id) REFERENCES sale_invoices(id) ON UPDATE CASCADE ON DELETE RESTRICT;`,
    `ALTER TABLE public.customers DROP CONSTRAINT fk_customers_company_id, ADD CONSTRAINT fk_customers_company_id FOREIGN KEY (company_id) REFERENCES companies(id) ON UPDATE CASCADE ON DELETE RESTRICT;`,
    `ALTER TABLE public.deliveries DROP CONSTRAINT fk_deliveries_delivery_company_id, ADD CONSTRAINT fk_deliveries_delivery_company_id FOREIGN KEY (delivery_company_id) REFERENCES delivery_companies(id) ON UPDATE CASCADE ON DELETE RESTRICT;`,
    `ALTER TABLE public.deliveries DROP CONSTRAINT fk_deliveries_company_id, ADD CONSTRAINT fk_deliveries_company_id FOREIGN KEY (company_id) REFERENCES companies(id) ON UPDATE CASCADE ON DELETE RESTRICT;`,
    `ALTER TABLE public.delivery_companies DROP CONSTRAINT fk_delivery_companies_company_id, ADD CONSTRAINT fk_delivery_companies_company_id FOREIGN KEY (company_id) REFERENCES companies(id) ON UPDATE CASCADE ON DELETE RESTRICT;`,
    `ALTER TABLE public.employees DROP CONSTRAINT fk_employees_company_id, ADD CONSTRAINT fk_employees_company_id FOREIGN KEY (company_id) REFERENCES companies(id) ON UPDATE CASCADE ON DELETE RESTRICT;`,
    `ALTER TABLE public.expenses DROP CONSTRAINT fk_expenses_company_id, ADD CONSTRAINT fk_expenses_company_id FOREIGN KEY (company_id) REFERENCES companies(id) ON UPDATE CASCADE ON DELETE RESTRICT;`,
    `ALTER TABLE public.financial_movements DROP CONSTRAINT fk_financial_movements_company_id, ADD CONSTRAINT fk_financial_movements_company_id FOREIGN KEY (company_id) REFERENCES companies(id) ON UPDATE CASCADE ON DELETE RESTRICT;`,
    `ALTER TABLE public.fixed_expense_periods DROP CONSTRAINT fk_fixed_expense_periods_company_id, ADD CONSTRAINT fk_fixed_expense_periods_company_id FOREIGN KEY (company_id) REFERENCES companies(id) ON UPDATE CASCADE ON DELETE RESTRICT;`,
    `ALTER TABLE public.fixed_expenses DROP CONSTRAINT fk_fixed_expenses_company_id, ADD CONSTRAINT fk_fixed_expenses_company_id FOREIGN KEY (company_id) REFERENCES companies(id) ON UPDATE CASCADE ON DELETE RESTRICT;`,
    `ALTER TABLE public.inventory_movements DROP CONSTRAINT inventory_movements_product_id_fkey, ADD CONSTRAINT inventory_movements_product_id_fkey FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE RESTRICT;`,
    `ALTER TABLE public.inventory_movements DROP CONSTRAINT inventory_movements_company_id_fkey, ADD CONSTRAINT inventory_movements_company_id_fkey FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE RESTRICT;`,
    `ALTER TABLE public.packagings DROP CONSTRAINT fk_packagings_company_id, ADD CONSTRAINT fk_packagings_company_id FOREIGN KEY (company_id) REFERENCES companies(id) ON UPDATE CASCADE ON DELETE RESTRICT;`,
    `ALTER TABLE public.product_cost_history DROP CONSTRAINT fk_pch_product_id, ADD CONSTRAINT fk_pch_product_id FOREIGN KEY (product_id) REFERENCES products(id) ON UPDATE CASCADE ON DELETE RESTRICT;`,
    `ALTER TABLE public.product_cost_history DROP CONSTRAINT fk_pch_company_id, ADD CONSTRAINT fk_pch_company_id FOREIGN KEY (company_id) REFERENCES companies(id) ON UPDATE CASCADE ON DELETE RESTRICT;`,
    `ALTER TABLE public.product_price_history DROP CONSTRAINT fk_pph_company_id, ADD CONSTRAINT fk_pph_company_id FOREIGN KEY (company_id) REFERENCES companies(id) ON UPDATE CASCADE ON DELETE RESTRICT;`,
    `ALTER TABLE public.product_price_history DROP CONSTRAINT fk_pph_product_id, ADD CONSTRAINT fk_pph_product_id FOREIGN KEY (product_id) REFERENCES products(id) ON UPDATE CASCADE ON DELETE RESTRICT;`,
    `ALTER TABLE public.product_price_history DROP CONSTRAINT fk_pph_product_price_id, ADD CONSTRAINT fk_pph_product_price_id FOREIGN KEY (product_price_id) REFERENCES product_prices(id) ON UPDATE CASCADE ON DELETE RESTRICT;`,
    `ALTER TABLE public.product_prices DROP CONSTRAINT fk_product_prices_company_id, ADD CONSTRAINT fk_product_prices_company_id FOREIGN KEY (company_id) REFERENCES companies(id) ON UPDATE CASCADE ON DELETE RESTRICT;`,
    `ALTER TABLE public.products DROP CONSTRAINT fk_products_company_id, ADD CONSTRAINT fk_products_company_id FOREIGN KEY (company_id) REFERENCES companies(id) ON UPDATE CASCADE ON DELETE RESTRICT;`,
    `ALTER TABLE public.products DROP CONSTRAINT fk_products_parent_id, ADD CONSTRAINT fk_products_parent_id FOREIGN KEY (parent_id) REFERENCES products(id) ON UPDATE CASCADE ON DELETE RESTRICT;`,
    `ALTER TABLE public.purchase_credits DROP CONSTRAINT fk_purchase_credits_supplier_id, ADD CONSTRAINT fk_purchase_credits_supplier_id FOREIGN KEY (supplier_id) REFERENCES suppliers(id) ON UPDATE CASCADE ON DELETE RESTRICT;`,
    `ALTER TABLE public.purchase_credits DROP CONSTRAINT fk_purchase_credits_company_id, ADD CONSTRAINT fk_purchase_credits_company_id FOREIGN KEY (company_id) REFERENCES companies(id) ON UPDATE CASCADE ON DELETE RESTRICT;`,
    `ALTER TABLE public.purchase_lines DROP CONSTRAINT fk_purchase_lines_company_id, ADD CONSTRAINT fk_purchase_lines_company_id FOREIGN KEY (company_id) REFERENCES companies(id) ON UPDATE CASCADE ON DELETE RESTRICT;`,
    `ALTER TABLE public.purchase_lines DROP CONSTRAINT fk_purchase_lines_packaging_id, ADD CONSTRAINT fk_purchase_lines_packaging_id FOREIGN KEY (packaging_id) REFERENCES packagings(id) ON UPDATE CASCADE ON DELETE RESTRICT;`,
    `ALTER TABLE public.purchase_lines DROP CONSTRAINT fk_purchase_lines_supplier_id, ADD CONSTRAINT fk_purchase_lines_supplier_id FOREIGN KEY (supplier_id) REFERENCES suppliers(id) ON UPDATE CASCADE ON DELETE RESTRICT;`,
    `ALTER TABLE public.purchase_lines DROP CONSTRAINT fk_purchase_lines_product_id, ADD CONSTRAINT fk_purchase_lines_product_id FOREIGN KEY (product_id) REFERENCES products(id) ON UPDATE CASCADE ON DELETE RESTRICT;`,
    `ALTER TABLE public.purchase_payments DROP CONSTRAINT fk_purchase_payments_company_id, ADD CONSTRAINT fk_purchase_payments_company_id FOREIGN KEY (company_id) REFERENCES companies(id) ON UPDATE CASCADE ON DELETE RESTRICT;`,
    `ALTER TABLE public.purchases DROP CONSTRAINT fk_purchases_company_id, ADD CONSTRAINT fk_purchases_company_id FOREIGN KEY (company_id) REFERENCES companies(id) ON UPDATE CASCADE ON DELETE RESTRICT;`,
    `ALTER TABLE public.purchases DROP CONSTRAINT fk_purchases_carrier_id, ADD CONSTRAINT fk_purchases_carrier_id FOREIGN KEY (carrier_id) REFERENCES carriers(id) ON UPDATE CASCADE ON DELETE RESTRICT;`,
    `ALTER TABLE public.purchases DROP CONSTRAINT fk_purchases_supplier_id, ADD CONSTRAINT fk_purchases_supplier_id FOREIGN KEY (supplier_id) REFERENCES suppliers(id) ON UPDATE CASCADE ON DELETE RESTRICT;`,
    `ALTER TABLE public.sale_credits DROP CONSTRAINT fk_sale_credits_customer_id, ADD CONSTRAINT fk_sale_credits_customer_id FOREIGN KEY (customer_id) REFERENCES customers(id) ON UPDATE CASCADE ON DELETE RESTRICT;`,
    `ALTER TABLE public.sale_credits DROP CONSTRAINT fk_sale_credits_company_id, ADD CONSTRAINT fk_sale_credits_company_id FOREIGN KEY (company_id) REFERENCES companies(id) ON UPDATE CASCADE ON DELETE RESTRICT;`,
    `ALTER TABLE public.sale_invoice_lines DROP CONSTRAINT fk_sale_invoice_lines_packaging_id, ADD CONSTRAINT fk_sale_invoice_lines_packaging_id FOREIGN KEY (packaging_id) REFERENCES packagings(id) ON UPDATE CASCADE ON DELETE RESTRICT;`,
    `ALTER TABLE public.sale_invoice_lines DROP CONSTRAINT fk_sale_invoice_lines_product_price_id, ADD CONSTRAINT fk_sale_invoice_lines_product_price_id FOREIGN KEY (product_price_id) REFERENCES product_prices(id) ON UPDATE CASCADE ON DELETE RESTRICT;`,
    `ALTER TABLE public.sale_invoice_lines DROP CONSTRAINT fk_sale_invoice_lines_product_id, ADD CONSTRAINT fk_sale_invoice_lines_product_id FOREIGN KEY (product_id) REFERENCES products(id) ON UPDATE CASCADE ON DELETE RESTRICT;`,
    `ALTER TABLE public.sale_invoice_lines DROP CONSTRAINT fk_sale_invoice_lines_company_id, ADD CONSTRAINT fk_sale_invoice_lines_company_id FOREIGN KEY (company_id) REFERENCES companies(id) ON UPDATE CASCADE ON DELETE RESTRICT;`,
    `ALTER TABLE public.sale_invoices DROP CONSTRAINT fk_sale_invoices_company_id, ADD CONSTRAINT fk_sale_invoices_company_id FOREIGN KEY (company_id) REFERENCES companies(id) ON UPDATE CASCADE ON DELETE RESTRICT;`,
    `ALTER TABLE public.sale_payments DROP CONSTRAINT fk_sale_payments_company_id, ADD CONSTRAINT fk_sale_payments_company_id FOREIGN KEY (company_id) REFERENCES companies(id) ON UPDATE CASCADE ON DELETE RESTRICT;`,
    `ALTER TABLE public.suppliers DROP CONSTRAINT fk_suppliers_company_id, ADD CONSTRAINT fk_suppliers_company_id FOREIGN KEY (company_id) REFERENCES companies(id) ON UPDATE CASCADE ON DELETE RESTRICT;`,
    `ALTER TABLE public.ticket_settings DROP CONSTRAINT fk_ticket_settings_company_id, ADD CONSTRAINT fk_ticket_settings_company_id FOREIGN KEY (company_id) REFERENCES companies(id) ON UPDATE CASCADE ON DELETE RESTRICT;`,
    `ALTER TABLE public.users DROP CONSTRAINT fk_users_company_id, ADD CONSTRAINT fk_users_company_id FOREIGN KEY (company_id) REFERENCES companies(id) ON UPDATE CASCADE ON DELETE RESTRICT;`,
    `ALTER TABLE public.wallets DROP CONSTRAINT fk_wallets_company_id, ADD CONSTRAINT fk_wallets_company_id FOREIGN KEY (company_id) REFERENCES companies(id) ON UPDATE CASCADE ON DELETE RESTRICT;`,
  ];

  public async up(queryRunner: QueryRunner): Promise<void> {
    for (const stmt of this.forward) {
      await queryRunner.query(stmt);
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    for (const stmt of this.backward) {
      await queryRunner.query(stmt);
    }
  }
}
