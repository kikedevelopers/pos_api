import { ConflictException, Injectable } from '@nestjs/common';
import { DataSource, type EntityManager } from 'typeorm';

import { CreateDefaultAlertConfigsAction } from '@/modules/alert-configs/actions/create-default-alert-configs.action';
import { CreateDefaultAppSettingsAction } from '@/modules/app-settings/actions/create-default-app-settings.action';
import { Bank } from '@/modules/banks/entities/bank.entity';
import { Carrier } from '@/modules/carriers/entities/carrier.entity';
import { Category } from '@/modules/categories/entities/category.entity';
import { Company } from '@/modules/companies/entities/company.entity';
import { CreditNote } from '@/modules/credit-notes/entities/credit-note.entity';
import { CreditNoteLine } from '@/modules/credit-notes/entities/credit-note-line.entity';
import { Customer } from '@/modules/customers/entities/customer.entity';
import { Employee } from '@/modules/employees/entities/employee.entity';
import { Expense } from '@/modules/expenses/entities/expense.entity';
import { Packaging } from '@/modules/packagings/entities/packaging.entity';
import { Product } from '@/modules/products/entities/product.entity';
import { ProductPrice } from '@/modules/products/entities/product-price.entity';
import { Purchase } from '@/modules/purchases/entities/purchase.entity';
import { PurchaseLine } from '@/modules/purchases/entities/purchase-line.entity';
import { PurchasePayment } from '@/modules/purchases/entities/purchase-payment.entity';
import { SaleInvoice } from '@/modules/sales/entities/sale-invoice.entity';
import { SaleInvoiceLine } from '@/modules/sales/entities/sale-invoice-line.entity';
import { SalePayment } from '@/modules/sales/entities/sale-payment.entity';
import { Supplier } from '@/modules/suppliers/entities/supplier.entity';
import { CreateDefaultTicketSettingsAction } from '@/modules/ticket-settings/actions/create-default-ticket-settings.action';
import { User } from '@/modules/users/entities/user.entity';
import { CreateDefaultWalletAction } from '@/modules/wallets/actions/create-default-wallet.action';

import type { MigrationSummaryDto } from '../dto/migration-summary.dto';
import { seedEssentials } from '../internal/default-seeds';
import { IdRemapper } from '../internal/id-remapper';
import { MODULE_GLOBAL_ORDER, MODULE_INSERT_ORDER } from '../internal/insert-order';
import {
  type ParsedZip,
  type SelectableModule,
  type ZipRow,
  type ZipTableName,
} from '../internal/manifest.types';
import { resolveSelectedModules } from '../internal/module-graph';

/**
 * Lee strings opcionales sin convertir a "null" para falsy distintos de null.
 */
function asNullableString(v: unknown): string | null {
  if (v === null || v === undefined) {
    return null;
  }
  if (typeof v === 'string') {
    return v;
  }
  if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint') {
    return String(v);
  }
  return null;
}

function asString(v: unknown): string {
  if (typeof v === 'string') {
    return v;
  }
  if (v === null || v === undefined) {
    return '';
  }
  if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint') {
    return String(v);
  }
  return '';
}

function asNumber(v: unknown): number {
  if (typeof v === 'number') {
    return v;
  }
  if (typeof v === 'string') {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

function asNullableNumber(v: unknown): number | null {
  if (v === null || v === undefined) {
    return null;
  }
  return asNumber(v);
}

function asBoolean(v: unknown, fallback = false): boolean {
  if (typeof v === 'boolean') {
    return v;
  }
  if (v === 'true') {
    return true;
  }
  if (v === 'false') {
    return false;
  }
  return fallback;
}

function asDate(v: unknown): Date {
  if (v instanceof Date) {
    return v;
  }
  if (typeof v === 'string' || typeof v === 'number') {
    const d = new Date(v);
    if (!Number.isNaN(d.getTime())) {
      return d;
    }
  }
  return new Date();
}

function asNullableDate(v: unknown): Date | null {
  if (v === null || v === undefined) {
    return null;
  }
  return asDate(v);
}

/**
 * Inserta una company y un user owner pre-flight (fuera de TX) NO se hace —
 * todo va en la transacción. El pre-flight es solo el lookup de conflictos.
 */
@Injectable()
export class ImportZipAction {
  constructor(
    private readonly dataSource: DataSource,
    private readonly createDefaultWalletAction: CreateDefaultWalletAction,
    private readonly createDefaultTicketSettingsAction: CreateDefaultTicketSettingsAction,
    private readonly createDefaultAppSettingsAction: CreateDefaultAppSettingsAction,
    private readonly createDefaultAlertConfigsAction: CreateDefaultAlertConfigsAction,
  ) {}

  async execute(zip: ParsedZip, selectedInput: SelectableModule[]): Promise<MigrationSummaryDto> {
    const startedAt = Date.now();

    const companyRow = this.firstRowRequired(zip, 'companies');
    const userRow = this.firstRowRequired(zip, 'users');
    const documentNumber = asNullableString(companyRow.document_number);
    const email = asString(userRow.email).trim().toLowerCase();

    // Pre-flight: conflicto contra BD. Se ejecuta fuera de la TX para abortar
    // sin reservar locks innecesarios.
    await this.assertNoConflicts(documentNumber, email);

    const selectedModules = resolveSelectedModules(selectedInput);
    const inserted: Record<string, number> = {};
    const warnings: string[] = [];

    const { companyIdReal, userIdReal } = await this.dataSource.transaction(async (manager) => {
      // 1. Insertar Company.
      const company = await this.insertCompany(manager, companyRow);
      inserted.companies = 1;

      // 2. Insertar User owner (password ya hasheado en argon2id).
      const user = await this.insertUser(manager, userRow, company.id);
      inserted.users = 1;

      // 3. Seeds esenciales.
      const ownerFullName = `${user.name} ${user.lastname}`.trim();
      const seeds = await seedEssentials(
        {
          manager,
          companyId: Number(company.id),
          ownerUserId: Number(user.id),
          ownerFullName,
        },
        this.createDefaultWalletAction,
        this.createDefaultTicketSettingsAction,
        this.createDefaultAppSettingsAction,
        this.createDefaultAlertConfigsAction,
      );
      inserted.ticket_settings = 6;
      inserted.wallets = 1;
      inserted.cash_registers = 1;
      inserted.app_settings = 2;
      inserted.alert_configs = 1;

      // 4. Procesar módulos seleccionados en orden topológico.
      const ctx: ImportCtx = {
        manager,
        zip,
        remapper: new IdRemapper(),
        companyIdReal: company.id,
        userIdReal: user.id,
        ownerFullName,
        defaultWalletId: seeds.walletId,
        defaultCashRegisterId: seeds.cashRegisterId,
        warnings,
      };

      for (const mod of MODULE_GLOBAL_ORDER) {
        if (!selectedModules.includes(mod)) {
          continue;
        }
        const tables = MODULE_INSERT_ORDER[mod];
        for (const table of tables) {
          const count = await this.insertTable(ctx, table);
          if (count > 0) {
            inserted[table] = (inserted[table] ?? 0) + count;
          }
        }
      }

      return { companyIdReal: company.id, userIdReal: user.id };
    });

    // El manifest del ZIP también lleva warnings — los anexamos al final.
    for (const w of zip.manifest.warnings) {
      warnings.push(w);
    }

    return {
      company_id_real: String(companyIdReal),
      user_id_real: String(userIdReal),
      inserted,
      warnings,
      duration_ms: Date.now() - startedAt,
    };
  }

  // ---------------------------------------------------------------------
  // Pre-flight
  // ---------------------------------------------------------------------

  private async assertNoConflicts(documentNumber: string | null, email: string): Promise<void> {
    // Company.document_number: paridad PlacePos no impone UNIQUE global,
    // pero para evitar duplicar la misma migración por error chequeamos
    // existencia. Si el dump no traía document_number, se omite.
    if (documentNumber !== null && documentNumber.trim() !== '') {
      const exists = await this.dataSource
        .getRepository(Company)
        .createQueryBuilder('c')
        .where('c.document_number = :doc', { doc: documentNumber })
        .getOne();
      if (exists) {
        throw new ConflictException({
          message: 'Ya existe una Company con ese document_number',
          payload: { code: 'COMPANY_EXISTS', field: 'document_number', value: documentNumber },
        });
      }
    }

    if (email !== '') {
      const userExists = await this.dataSource.getRepository(User).findOne({ where: { email } });
      if (userExists) {
        throw new ConflictException({
          message: 'Ya existe un User con ese email',
          payload: { code: 'EMAIL_TAKEN', field: 'email', value: email },
        });
      }
    }
  }

  private firstRowRequired(zip: ParsedZip, table: ZipTableName): ZipRow {
    const rows = zip.tables.get(table) ?? [];
    if (rows.length === 0) {
      throw new ConflictException({
        message: `El ZIP no contiene filas en ${table}`,
        payload: { code: 'EMPTY_TABLE', field: table },
      });
    }
    return rows[0];
  }

  // ---------------------------------------------------------------------
  // Inserts base
  // ---------------------------------------------------------------------

  private async insertCompany(manager: EntityManager, row: ZipRow): Promise<Company> {
    const repo = manager.getRepository(Company);
    const entity = repo.create({
      name: asString(row.name).trim() || '(Sin nombre)',
      document_number: asNullableString(row.document_number),
      balance: asNumber(row.balance),
      address: asNullableString(row.address),
      email: asNullableString(row.email),
      phone_number: asNullableString(row.phone_number),
      break_even_amount: asNumber(row.break_even_amount),
      break_even_period_days:
        row.break_even_period_days !== undefined ? Number(row.break_even_period_days) : 30,
    });
    return repo.save(entity);
  }

  private async insertUser(manager: EntityManager, row: ZipRow, companyId: string): Promise<User> {
    const repo = manager.getRepository(User);
    const entity = repo.create({
      name: asString(row.name).trim() || 'Owner',
      lastname: asString(row.lastname).trim() || '',
      email: asString(row.email).trim().toLowerCase(),
      // Password viene argon2id PHC desde el ZIP — NO se re-hashea.
      password: asString(row.password),
      type: 'owner' as User['type'],
      balance: asNumber(row.balance),
      company_id: companyId,
    });
    return repo.save(entity);
  }

  // ---------------------------------------------------------------------
  // Dispatcher por tabla
  // ---------------------------------------------------------------------

  private async insertTable(ctx: ImportCtx, table: ZipTableName): Promise<number> {
    const rows = ctx.zip.tables.get(table) ?? [];
    if (rows.length === 0) {
      return 0;
    }

    switch (table) {
      case 'categories':
        return this.insertCategories(ctx, rows);
      case 'packagings':
        return this.insertPackagings(ctx, rows);
      case 'products':
        return this.insertProducts(ctx, rows);
      case 'product_prices':
        return this.insertProductPrices(ctx, rows);
      case 'customers':
        return this.insertCustomers(ctx, rows);
      case 'suppliers':
        return this.insertSuppliers(ctx, rows);
      case 'banks':
        return this.insertBanks(ctx, rows);
      case 'carriers':
        return this.insertCarriers(ctx, rows);
      case 'employees':
        return this.insertEmployees(ctx, rows);
      case 'sale_invoices':
        return this.insertSaleInvoices(ctx, rows);
      case 'sale_invoice_lines':
        return this.insertSaleInvoiceLines(ctx, rows);
      case 'sale_payments':
        return this.insertSalePayments(ctx, rows);
      case 'credit_notes':
        return this.insertCreditNotes(ctx, rows);
      case 'credit_note_lines':
        return this.insertCreditNoteLines(ctx, rows);
      case 'purchases':
        return this.insertPurchases(ctx, rows);
      case 'purchase_lines':
        return this.insertPurchaseLines(ctx, rows);
      case 'purchase_payments':
        return this.insertPurchasePayments(ctx, rows);
      case 'expenses':
        return this.insertExpenses(ctx, rows);
      default:
        ctx.warnings.push(`insertTable: tabla ${table} sin handler — fila ignorada`);
        return 0;
    }
  }

  // ---------------------------------------------------------------------
  // Catálogo
  // ---------------------------------------------------------------------

  private async insertCategories(ctx: ImportCtx, rows: ZipRow[]): Promise<number> {
    const repo = ctx.manager.getRepository(Category);
    const seen = new Set<string>();
    let count = 0;
    for (const row of rows) {
      const localId = asString(row.id);
      let name = asString(row.name).trim();
      if (name === '') {
        name = `Categoría ${localId}`;
      }
      // Defensa local: UNIQUE per-company sobre lower(btrim(name)).
      let final = name;
      let suffix = 1;
      while (seen.has(final.toLowerCase())) {
        suffix++;
        final = `${name} (${suffix})`;
      }
      seen.add(final.toLowerCase());

      const saved = await repo.save(
        repo.create({
          company_id: ctx.companyIdReal,
          name: final,
          is_archived: asBoolean(row.is_archived),
        }),
      );
      ctx.remapper.set('categories', localId, saved.id);
      count++;
    }
    return count;
  }

  private async insertPackagings(ctx: ImportCtx, rows: ZipRow[]): Promise<number> {
    const repo = ctx.manager.getRepository(Packaging);
    const seen = new Set<string>();
    let count = 0;
    for (const row of rows) {
      const localId = asString(row.id);
      let name = asString(row.name).trim();
      if (name === '') {
        name = `Empaque ${localId}`;
      }
      let final = name;
      let suffix = 1;
      while (seen.has(final.toLowerCase())) {
        suffix++;
        final = `${name} (${suffix})`;
      }
      seen.add(final.toLowerCase());

      const saved = await repo.save(
        repo.create({
          company_id: ctx.companyIdReal,
          name: final,
          value: asNumber(row.value),
          is_archived: asBoolean(row.is_archived),
          created_by: asNullableString(row.created_by) ?? ctx.ownerFullName,
          created_by_id: ctx.userIdReal,
        }),
      );
      ctx.remapper.set('packagings', localId, saved.id);
      count++;
    }
    return count;
  }

  private async insertProducts(ctx: ImportCtx, rows: ZipRow[]): Promise<number> {
    const repo = ctx.manager.getRepository(Product);
    const seen = new Set<string>();
    let count = 0;
    for (const row of rows) {
      const localId = asString(row.id);
      let name = asString(row.name).trim();
      if (name === '') {
        name = `Producto ${localId}`;
      }
      let final = name;
      let suffix = 1;
      while (seen.has(final.toLowerCase())) {
        suffix++;
        final = `${name} (${suffix})`;
      }
      seen.add(final.toLowerCase());

      const productType = row.product_type === 'COMBO' ? 'COMBO' : 'SIMPLE';

      const saved = await repo.save(
        repo.create({
          company_id: ctx.companyIdReal,
          name: final,
          description: asNullableString(row.description),
          product_type: productType as Product['product_type'],
          parent_id: ctx.remapper.getOptional('products', asNullableString(row.parent_id)),
          sku_code: asNullableString(row.sku_code),
          bar_code: asNullableString(row.bar_code),
          packaging_id: ctx.remapper.getOptional('packagings', asNullableString(row.packaging_id)),
          category_id: ctx.remapper.getOptional('categories', asNullableString(row.category_id)),
          cost: asNumber(row.cost),
          stock: asNumber(row.stock),
          is_purchasable: asBoolean(row.is_purchasable, true),
          hash: asNullableString(row.hash),
          image: asNullableString(row.image),
          show_in_pos: asBoolean(row.show_in_pos, true),
          is_archived: asBoolean(row.is_archived),
          created_by: asNullableString(row.created_by) ?? ctx.ownerFullName,
          created_by_id: ctx.userIdReal,
          updated_by: asNullableString(row.updated_by),
          updated_by_id: null,
        }),
      );
      ctx.remapper.set('products', localId, saved.id);
      count++;
    }
    return count;
  }

  private async insertProductPrices(ctx: ImportCtx, rows: ZipRow[]): Promise<number> {
    const repo = ctx.manager.getRepository(ProductPrice);
    let count = 0;
    let skipped = 0;
    for (const row of rows) {
      const localId = asString(row.id);
      const localProductId = asNullableString(row.product_id);
      if (localProductId === null) {
        skipped++;
        continue;
      }
      const productIdReal = ctx.remapper.getOptional('products', localProductId);
      if (productIdReal === null) {
        skipped++;
        continue;
      }
      const saved = await repo.save(
        repo.create({
          company_id: ctx.companyIdReal,
          product_id: productIdReal,
          name: asString(row.name) || 'Base',
          sale_price: asNumber(row.sale_price),
          profit: Math.max(0, asNumber(row.profit)),
          margin: Math.max(0, asNumber(row.margin)),
          iva_percentage: asNumber(row.iva_percentage),
          created_by: asNullableString(row.created_by) ?? ctx.ownerFullName,
          created_by_id: ctx.userIdReal,
        }),
      );
      ctx.remapper.set('product_prices', localId, saved.id);
      count++;
    }
    if (skipped > 0) {
      ctx.warnings.push(`product_prices: ${skipped} filas descartadas por product_id no resoluble`);
    }
    return count;
  }

  // ---------------------------------------------------------------------
  // Personas
  // ---------------------------------------------------------------------

  private async insertCustomers(ctx: ImportCtx, rows: ZipRow[]): Promise<number> {
    const repo = ctx.manager.getRepository(Customer);
    let count = 0;
    for (const row of rows) {
      const localId = asString(row.id);
      const personType = row.person_type === 'COMPANY' ? 'COMPANY' : 'INDIVIDUAL';
      const saved = await repo.save(
        repo.create({
          company_id: ctx.companyIdReal,
          person_type: personType as Customer['person_type'],
          name: asString(row.name).trim() || 'Cliente',
          email: asNullableString(row.email),
          phone: asNullableString(row.phone),
          doc_number: asNullableString(row.doc_number),
          address: asNullableString(row.address),
          balance: asNumber(row.balance),
          is_archived: asBoolean(row.is_archived),
          created_by: asNullableString(row.created_by) ?? ctx.ownerFullName,
          created_by_id: ctx.userIdReal,
        }),
      );
      ctx.remapper.set('customers', localId, saved.id);
      count++;
    }
    return count;
  }

  private async insertSuppliers(ctx: ImportCtx, rows: ZipRow[]): Promise<number> {
    const repo = ctx.manager.getRepository(Supplier);
    let count = 0;
    for (const row of rows) {
      const localId = asString(row.id);
      const paymentAccounts = Array.isArray(row.payment_accounts)
        ? (row.payment_accounts as Supplier['payment_accounts'])
        : [];
      const saved = await repo.save(
        repo.create({
          company_id: ctx.companyIdReal,
          legal_name: asString(row.legal_name).trim() || `Proveedor ${localId}`,
          broker: asNullableString(row.broker),
          address: asNullableString(row.address),
          phone: asNullableString(row.phone),
          doc_number: asNullableString(row.doc_number),
          email: asNullableString(row.email),
          accumulated_debt: Math.max(0, asNumber(row.accumulated_debt)),
          credit_balance: Math.max(0, asNumber(row.credit_balance)),
          payment_accounts: paymentAccounts,
          is_archived: asBoolean(row.is_archived),
          created_by: asNullableString(row.created_by) ?? ctx.ownerFullName,
          created_by_id: ctx.userIdReal,
        }),
      );
      ctx.remapper.set('suppliers', localId, saved.id);
      count++;
    }
    return count;
  }

  private async insertBanks(ctx: ImportCtx, rows: ZipRow[]): Promise<number> {
    const repo = ctx.manager.getRepository(Bank);
    let count = 0;
    const seenKey = new Set<string>();
    for (const row of rows) {
      const localId = asString(row.id);
      const baseName = asString(row.name).trim() || `Banco ${localId}`;
      const account = asString(row.account_number).trim() || `cuenta-${localId}`;
      let finalName = baseName;
      let suffix = 1;
      while (seenKey.has(`${finalName.toLowerCase()}|${account}`)) {
        suffix++;
        finalName = `${baseName} (${suffix})`;
      }
      seenKey.add(`${finalName.toLowerCase()}|${account}`);

      const accountType = row.account_type === 'checking' ? 'checking' : 'savings';

      const saved = await repo.save(
        repo.create({
          company_id: ctx.companyIdReal,
          name: finalName,
          account_number: account,
          account_type: accountType as Bank['account_type'],
          balance: asNumber(row.balance),
          available_in_pos: asBoolean(row.available_in_pos, true),
          is_archived: asBoolean(row.is_archived),
          created_by: asNullableString(row.created_by) ?? ctx.ownerFullName,
          created_by_id: ctx.userIdReal,
        }),
      );
      ctx.remapper.set('banks', localId, saved.id);
      count++;
    }
    return count;
  }

  private async insertCarriers(ctx: ImportCtx, rows: ZipRow[]): Promise<number> {
    const repo = ctx.manager.getRepository(Carrier);
    const seen = new Set<string>();
    let count = 0;
    for (const row of rows) {
      const localId = asString(row.id);
      let name = asString(row.name).trim();
      if (name === '') {
        name = `Transportista ${localId}`;
      }
      let final = name;
      let suffix = 1;
      while (seen.has(final.toLowerCase())) {
        suffix++;
        final = `${name} (${suffix})`;
      }
      seen.add(final.toLowerCase());

      const saved = await repo.save(
        repo.create({
          company_id: ctx.companyIdReal,
          name: final,
          identification: asNullableString(row.identification),
          phone: asNullableString(row.phone),
          email: asNullableString(row.email),
          notes: asNullableString(row.notes),
          is_archived: asBoolean(row.is_archived),
          created_by: asNullableString(row.created_by) ?? ctx.ownerFullName,
          created_by_id: ctx.userIdReal,
        }),
      );
      ctx.remapper.set('carriers', localId, saved.id);
      count++;
    }
    return count;
  }

  private async insertEmployees(ctx: ImportCtx, rows: ZipRow[]): Promise<number> {
    const repo = ctx.manager.getRepository(Employee);
    let count = 0;
    for (const row of rows) {
      const localId = asString(row.id);
      // role: 'manager' | 'employee'. login_enabled=false con username/password null.
      const role = row.role === 'manager' ? 'manager' : 'employee';
      const saved = await repo.save(
        repo.create({
          company_id: ctx.companyIdReal,
          name: asString(row.name).trim() || 'Empleado',
          phone: asNullableString(row.phone),
          email: asNullableString(row.email),
          address: asNullableString(row.address),
          role: role as Employee['role'],
          login_enabled: false,
          username: null,
          password: null,
          is_archived: asBoolean(row.is_archived),
          created_by: asNullableString(row.created_by) ?? ctx.ownerFullName,
          created_by_id: ctx.userIdReal,
          user_id: null,
        }),
      );
      ctx.remapper.set('employees', localId, saved.id);
      count++;
    }
    return count;
  }

  // ---------------------------------------------------------------------
  // Ventas
  // ---------------------------------------------------------------------

  private async insertSaleInvoices(ctx: ImportCtx, rows: ZipRow[]): Promise<number> {
    const repo = ctx.manager.getRepository(SaleInvoice);
    let count = 0;
    for (const row of rows) {
      const localId = asString(row.id);
      const ticketType = row.ticket_type === 'ORDER' ? 'ORDER' : 'SALE';
      const localCustomer = asNullableString(row.customer_id);
      const customerIdReal = ctx.remapper.getOptional('customers', localCustomer);

      const saved = await repo.save(
        repo.create({
          company_id: ctx.companyIdReal,
          ticket_type: ticketType as SaleInvoice['ticket_type'],
          ticket_number: asString(row.ticket_number).trim() || `TKT-${localId}`,
          sale_number:
            ticketType === 'SALE' ? (asNullableString(row.sale_number) ?? `VTA-${localId}`) : null,
          customer_id: customerIdReal,
          customer_name: asNullableString(row.customer_name),
          subtotal: Math.max(0, asNumber(row.subtotal)),
          tax_total: Math.max(0, asNumber(row.tax_total)),
          total: Math.max(0, asNumber(row.total)),
          cost: Math.max(0, asNumber(row.cost)),
          profit: asNumber(row.profit),
          margin: asNumber(row.margin),
          notes: asNullableString(row.notes),
          created_by: asNullableString(row.created_by) ?? ctx.ownerFullName,
          created_by_id: ctx.userIdReal,
          is_deleted: asBoolean(row.is_deleted),
        }),
      );
      ctx.remapper.set('sale_invoices', localId, saved.id);
      count++;
    }
    return count;
  }

  private async insertSaleInvoiceLines(ctx: ImportCtx, rows: ZipRow[]): Promise<number> {
    const repo = ctx.manager.getRepository(SaleInvoiceLine);
    let count = 0;
    let skipped = 0;
    for (const row of rows) {
      const invoiceIdReal = ctx.remapper.getOptional(
        'sale_invoices',
        asNullableString(row.sale_invoice_id),
      );
      const productIdReal = ctx.remapper.getOptional('products', asNullableString(row.product_id));
      if (invoiceIdReal === null || productIdReal === null) {
        skipped++;
        continue;
      }
      const quantity = asNumber(row.quantity);
      if (quantity <= 0) {
        skipped++;
        continue;
      }

      const saved = await repo.save(
        repo.create({
          company_id: ctx.companyIdReal,
          sale_invoice_id: invoiceIdReal,
          product_id: productIdReal,
          packaging_id: ctx.remapper.getOptional('packagings', asNullableString(row.packaging_id)),
          product_price_id: ctx.remapper.getOptional(
            'product_prices',
            asNullableString(row.product_price_id),
          ),
          description: asString(row.description).trim() || `Producto ${productIdReal}`,
          quantity,
          unit_price: Math.max(0, asNumber(row.unit_price)),
          unit_cost: Math.max(0, asNumber(row.unit_cost)),
          subtotal: Math.max(0, asNumber(row.subtotal)),
          iva_percentage: asNumber(row.iva_percentage),
          iva_amount: Math.max(0, asNumber(row.iva_amount)),
          total: Math.max(0, asNumber(row.total)),
          profit: Math.max(0, asNumber(row.profit)),
          margin: Math.max(0, asNumber(row.margin)),
        }),
      );
      ctx.remapper.set('sale_invoice_lines', asString(row.id), saved.id);
      count++;
    }
    if (skipped > 0) {
      ctx.warnings.push(
        `sale_invoice_lines: ${skipped} líneas descartadas (FK faltante o quantity inválida)`,
      );
    }
    return count;
  }

  private async insertSalePayments(ctx: ImportCtx, rows: ZipRow[]): Promise<number> {
    const repo = ctx.manager.getRepository(SalePayment);
    let count = 0;
    let skipped = 0;
    for (const row of rows) {
      const invoiceIdReal = ctx.remapper.getOptional(
        'sale_invoices',
        asNullableString(row.sale_invoice_id),
      );
      if (invoiceIdReal === null) {
        skipped++;
        continue;
      }
      const amount = asNumber(row.amount);
      if (amount <= 0) {
        skipped++;
        continue;
      }
      const method = row.payment_method === 'TRANSFER' ? 'TRANSFER' : 'CASH';

      // El ZIP envía account_id="1" sintético. Remapeo:
      //   CASH         → cash_register sembrado por defaults.
      //   TRANSFER     → bank si banks fueron importados; si no, cash_register
      //                  (paridad placepos: el migrador no resolvió bank real).
      // Tipo de cuenta original del ZIP (cash_register | bank | wallet).
      const zipAccountType = asString(row.account_type);
      let accountType: 'wallet' | 'bank' | 'cash_register';
      let accountId: string;
      if (method === 'CASH' || zipAccountType === 'cash_register') {
        accountType = 'cash_register';
        accountId = ctx.defaultCashRegisterId;
      } else if (zipAccountType === 'wallet') {
        accountType = 'wallet';
        accountId = ctx.defaultWalletId;
      } else {
        // TRANSFER + bank: si el bank fue migrado, lo usamos; si no, downgrade.
        const localBankId = asNullableString(row.account_id);
        const bankIdReal = ctx.remapper.getOptional('banks', localBankId);
        if (bankIdReal !== null) {
          accountType = 'bank';
          accountId = bankIdReal;
        } else {
          accountType = 'cash_register';
          accountId = ctx.defaultCashRegisterId;
        }
      }

      const saved = await repo.save(
        repo.create({
          company_id: ctx.companyIdReal,
          sale_invoice_id: invoiceIdReal,
          payment_method: method as SalePayment['payment_method'],
          amount,
          change_amount: Math.max(0, asNumber(row.change_amount)),
          bank_id: ctx.remapper.getOptional('banks', asNullableString(row.bank_id)),
          bank_name: asNullableString(row.bank_name),
          account_type: accountType,
          account_id: accountId,
          created_by: asNullableString(row.created_by) ?? ctx.ownerFullName,
          created_by_id: ctx.userIdReal,
          uuid: asNullableString(row.uuid),
        }),
      );
      ctx.remapper.set('sale_payments', asString(row.id), saved.id);
      count++;
    }
    if (skipped > 0) {
      ctx.warnings.push(
        `sale_payments: ${skipped} pagos descartados (FK faltante o monto inválido)`,
      );
    }
    return count;
  }

  private async insertCreditNotes(ctx: ImportCtx, rows: ZipRow[]): Promise<number> {
    const repo = ctx.manager.getRepository(CreditNote);
    let count = 0;
    let skipped = 0;
    for (const row of rows) {
      const invoiceIdReal = ctx.remapper.getOptional(
        'sale_invoices',
        asNullableString(row.sale_invoice_id),
      );
      if (invoiceIdReal === null) {
        skipped++;
        continue;
      }
      const noteType = row.note_type === 'DEBIT' ? 'DEBIT' : 'CREDIT';
      // Combinación legal: CREDIT + FULL_VOID|PARTIAL_VOID, DEBIT + ADDITION.
      const opTypeRaw = asString(row.operation_type);
      let operationType: 'FULL_VOID' | 'PARTIAL_VOID' | 'ADDITION';
      if (noteType === 'CREDIT') {
        operationType = opTypeRaw === 'PARTIAL_VOID' ? 'PARTIAL_VOID' : 'FULL_VOID';
      } else {
        operationType = 'ADDITION';
      }

      const saved = await repo.save(
        repo.create({
          company_id: ctx.companyIdReal,
          sale_invoice_id: invoiceIdReal,
          customer_id: ctx.remapper.getOptional('customers', asNullableString(row.customer_id)),
          note_number: asString(row.note_number).trim() || `NC-${asString(row.id)}`,
          note_type: noteType as CreditNote['note_type'],
          operation_type: operationType as CreditNote['operation_type'],
          subtotal: Math.max(0, asNumber(row.subtotal)),
          tax_total: Math.max(0, asNumber(row.tax_total)),
          total: Math.max(0, asNumber(row.total)),
          reason: asNullableString(row.reason),
          created_by: asNullableString(row.created_by) ?? ctx.ownerFullName,
          created_by_id: ctx.userIdReal,
          is_deleted: asBoolean(row.is_deleted),
        }),
      );
      ctx.remapper.set('credit_notes', asString(row.id), saved.id);
      count++;
    }
    if (skipped > 0) {
      ctx.warnings.push(
        `credit_notes: ${skipped} notas descartadas por sale_invoice padre inexistente`,
      );
    }
    return count;
  }

  private async insertCreditNoteLines(ctx: ImportCtx, rows: ZipRow[]): Promise<number> {
    const repo = ctx.manager.getRepository(CreditNoteLine);
    let count = 0;
    let skipped = 0;
    for (const row of rows) {
      const noteIdReal = ctx.remapper.getOptional(
        'credit_notes',
        asNullableString(row.credit_note_id),
      );
      const productIdReal = ctx.remapper.getOptional('products', asNullableString(row.product_id));
      if (noteIdReal === null || productIdReal === null) {
        skipped++;
        continue;
      }
      const quantity = asNumber(row.quantity);
      if (quantity <= 0) {
        skipped++;
        continue;
      }
      await repo.save(
        repo.create({
          company_id: ctx.companyIdReal,
          credit_note_id: noteIdReal,
          original_line_id: ctx.remapper.getOptional(
            'sale_invoice_lines',
            asNullableString(row.original_line_id),
          ),
          product_id: productIdReal,
          packaging_id: ctx.remapper.getOptional('packagings', asNullableString(row.packaging_id)),
          description: asString(row.description).trim() || `Producto ${productIdReal}`,
          quantity,
          unit_price: Math.max(0, asNumber(row.unit_price)),
          unit_cost: Math.max(0, asNumber(row.unit_cost)),
          subtotal: Math.max(0, asNumber(row.subtotal)),
          iva_percentage: asNumber(row.iva_percentage),
          iva_amount: Math.max(0, asNumber(row.iva_amount)),
          total: Math.max(0, asNumber(row.total)),
        }),
      );
      count++;
    }
    if (skipped > 0) {
      ctx.warnings.push(
        `credit_note_lines: ${skipped} líneas descartadas (FK faltante o qty inválida)`,
      );
    }
    return count;
  }

  // ---------------------------------------------------------------------
  // Compras
  // ---------------------------------------------------------------------

  private async insertPurchases(ctx: ImportCtx, rows: ZipRow[]): Promise<number> {
    const repo = ctx.manager.getRepository(Purchase);
    let count = 0;
    let skipped = 0;
    for (const row of rows) {
      const supplierIdReal = ctx.remapper.getOptional(
        'suppliers',
        asNullableString(row.supplier_id),
      );
      if (supplierIdReal === null) {
        skipped++;
        continue;
      }

      const invoiceDate = asNullableDate(row.invoice_date);

      const saved = await repo.save(
        repo.create({
          company_id: ctx.companyIdReal,
          purchase_number: asString(row.purchase_number).trim() || `COMP-${asString(row.id)}`,
          supplier_id: supplierIdReal,
          supplier_name: asString(row.supplier_name).trim() || `Proveedor ${supplierIdReal}`,
          subtotal: Math.max(0, asNumber(row.subtotal)),
          iva_total: Math.max(0, asNumber(row.iva_total)),
          total: Math.max(0, asNumber(row.total)),
          notes: asNullableString(row.notes),
          // El migrador siempre emite 'PENDING' (los CHECK de RECEIVED son
          // estrictos y el dump no garantiza receptor/transportista).
          status: 'PENDING' as Purchase['status'],
          carrier_name: asNullableString(row.carrier_name),
          carrier_id: ctx.remapper.getOptional('carriers', asNullableString(row.carrier_id)),
          transport_cost: Math.max(0, asNumber(row.transport_cost)),
          total_kilos: asNullableNumber(row.total_kilos),
          received_by: asNullableString(row.received_by),
          received_at: asNullableDate(row.received_at),
          invoice_date: invoiceDate,
          invoice_number: asNullableString(row.invoice_number),
          created_by: asNullableString(row.created_by) ?? ctx.ownerFullName,
          created_by_id: ctx.userIdReal,
          is_deleted: asBoolean(row.is_deleted),
        }),
      );
      ctx.remapper.set('purchases', asString(row.id), saved.id);
      count++;
    }
    if (skipped > 0) {
      ctx.warnings.push(`purchases: ${skipped} compras descartadas por supplier inexistente`);
    }
    return count;
  }

  private async insertPurchaseLines(ctx: ImportCtx, rows: ZipRow[]): Promise<number> {
    const repo = ctx.manager.getRepository(PurchaseLine);
    let count = 0;
    let skipped = 0;
    for (const row of rows) {
      const purchaseIdReal = ctx.remapper.getOptional(
        'purchases',
        asNullableString(row.purchase_id),
      );
      const productIdReal = ctx.remapper.getOptional('products', asNullableString(row.product_id));
      const supplierIdReal = ctx.remapper.getOptional(
        'suppliers',
        asNullableString(row.supplier_id),
      );
      if (purchaseIdReal === null || productIdReal === null || supplierIdReal === null) {
        skipped++;
        continue;
      }
      const packagingQty = asNumber(row.packaging_qty);
      if (packagingQty <= 0) {
        skipped++;
        continue;
      }
      await repo.save(
        repo.create({
          company_id: ctx.companyIdReal,
          purchase_id: purchaseIdReal,
          product_id: productIdReal,
          supplier_id: supplierIdReal,
          name: asString(row.name).trim() || `Producto ${productIdReal}`,
          packaging_id: ctx.remapper.getOptional('packagings', asNullableString(row.packaging_id)),
          packaging_name: asNullableString(row.packaging_name),
          packaging_value: asNullableNumber(row.packaging_value),
          packaging_qty: packagingQty,
          unit_qty: Math.max(0, asNumber(row.unit_qty)),
          unit_price: Math.max(0, asNumber(row.unit_price)),
          packaging_price: Math.max(0, asNumber(row.packaging_price)),
          iva_rate: Math.max(0, asNumber(row.iva_rate)),
          subtotal: Math.max(0, asNumber(row.subtotal)),
          iva_amount: Math.max(0, asNumber(row.iva_amount)),
          total: Math.max(0, asNumber(row.total)),
        }),
      );
      count++;
    }
    if (skipped > 0) {
      ctx.warnings.push(
        `purchase_lines: ${skipped} líneas descartadas (FK faltante o qty inválida)`,
      );
    }
    return count;
  }

  private async insertPurchasePayments(ctx: ImportCtx, rows: ZipRow[]): Promise<number> {
    const repo = ctx.manager.getRepository(PurchasePayment);
    let count = 0;
    let skipped = 0;
    for (const row of rows) {
      const purchaseIdReal = ctx.remapper.getOptional(
        'purchases',
        asNullableString(row.purchase_id),
      );
      if (purchaseIdReal === null) {
        skipped++;
        continue;
      }
      const amount = asNumber(row.amount);
      if (amount <= 0) {
        skipped++;
        continue;
      }
      const method = row.payment_method === 'TRANSFER' ? 'TRANSFER' : 'CASH';

      // source_type + source_id deben ser ambos null o ambos non-null.
      // El ZIP los emite null/null para no inventar IDs.
      const zipSourceType = asNullableString(row.source_type);
      let sourceType: 'wallet' | 'bank' | 'cash_register' | null = null;
      let sourceId: string | null = null;
      if (zipSourceType !== null) {
        if (zipSourceType === 'bank') {
          const bankIdReal = ctx.remapper.getOptional('banks', asNullableString(row.source_id));
          if (bankIdReal !== null) {
            sourceType = 'bank';
            sourceId = bankIdReal;
          }
        } else if (zipSourceType === 'wallet') {
          sourceType = 'wallet';
          sourceId = ctx.defaultWalletId;
        } else if (zipSourceType === 'cash_register') {
          sourceType = 'cash_register';
          sourceId = ctx.defaultCashRegisterId;
        }
      }

      await repo.save(
        repo.create({
          company_id: ctx.companyIdReal,
          purchase_id: purchaseIdReal,
          payment_number: asString(row.payment_number).trim() || `APC-${asString(row.id)}`,
          payment_method: method as PurchasePayment['payment_method'],
          amount,
          bank_id: ctx.remapper.getOptional('banks', asNullableString(row.bank_id)),
          bank_name: asNullableString(row.bank_name),
          source_type: sourceType,
          source_id: sourceId,
          notes: asNullableString(row.notes),
          created_by: asNullableString(row.created_by) ?? ctx.ownerFullName,
          created_by_id: ctx.userIdReal,
          uuid: asNullableString(row.uuid),
        }),
      );
      count++;
    }
    if (skipped > 0) {
      ctx.warnings.push(`purchase_payments: ${skipped} pagos descartados (FK o amount inválidos)`);
    }
    return count;
  }

  // ---------------------------------------------------------------------
  // Gastos
  // ---------------------------------------------------------------------

  private async insertExpenses(ctx: ImportCtx, rows: ZipRow[]): Promise<number> {
    const repo = ctx.manager.getRepository(Expense);
    let count = 0;
    let skipped = 0;
    for (const row of rows) {
      const amount = asNumber(row.amount);
      if (amount <= 0) {
        skipped++;
        continue;
      }
      // El ZIP emite source_type='cash_register' / source_id='1' por defecto.
      // Remapeamos a las fuentes reales sembradas en defaults.
      const zipSourceType = asString(row.source_type);
      let sourceType: 'bank' | 'wallet' | 'cash_register';
      let sourceId: string;
      if (zipSourceType === 'bank') {
        const bankIdReal = ctx.remapper.getOptional('banks', asNullableString(row.source_id));
        if (bankIdReal === null) {
          // Fallback a cash_register sembrado.
          sourceType = 'cash_register';
          sourceId = ctx.defaultCashRegisterId;
        } else {
          sourceType = 'bank';
          sourceId = bankIdReal;
        }
      } else if (zipSourceType === 'wallet') {
        sourceType = 'wallet';
        sourceId = ctx.defaultWalletId;
      } else {
        sourceType = 'cash_register';
        sourceId = ctx.defaultCashRegisterId;
      }

      await repo.save(
        repo.create({
          company_id: ctx.companyIdReal,
          description: asString(row.description).trim() || 'Gasto',
          amount,
          category: asNullableString(row.category),
          source_type: sourceType,
          source_id: sourceId,
          source_name: asNullableString(row.source_name) ?? 'Caja',
          expense_date: asDate(row.expense_date),
          notes: asNullableString(row.notes),
          is_archived: asBoolean(row.is_archived),
          created_by: asNullableString(row.created_by) ?? ctx.ownerFullName,
          created_by_id: ctx.userIdReal,
        }),
      );
      count++;
    }
    if (skipped > 0) {
      ctx.warnings.push(`expenses: ${skipped} gastos descartados por monto inválido`);
    }
    return count;
  }
}

/**
 * Contexto mutable que viaja por todos los inserts dentro de la transacción.
 * NO escapa de `execute()`.
 */
interface ImportCtx {
  manager: EntityManager;
  zip: ParsedZip;
  remapper: IdRemapper;
  companyIdReal: string;
  userIdReal: string;
  ownerFullName: string;
  defaultWalletId: string;
  defaultCashRegisterId: string;
  warnings: string[];
}
