import { ConflictException, Injectable } from '@nestjs/common';
import { DataSource, type EntityManager } from 'typeorm';

import { CreateDefaultAlertConfigsAction } from '@/modules/alert-configs/actions/create-default-alert-configs.action';
import { CreateDefaultAppSettingsAction } from '@/modules/app-settings/actions/create-default-app-settings.action';
import { Bank } from '@/modules/banks/entities/bank.entity';
import { Carrier } from '@/modules/carriers/entities/carrier.entity';
import {
  CarrierCredit,
  CarrierCreditStatus,
} from '@/modules/carriers/entities/carrier-credit.entity';
import {
  CarrierPayment,
  CarrierPaymentMethod,
} from '@/modules/carrier-payments/entities/carrier-payment.entity';
import { Category } from '@/modules/categories/entities/category.entity';
import { Company } from '@/modules/companies/entities/company.entity';
import { CorrectionSource } from '@/modules/credit-notes/entities/correction-source.entity';
import { CreditNote } from '@/modules/credit-notes/entities/credit-note.entity';
import { CreditNoteLine } from '@/modules/credit-notes/entities/credit-note-line.entity';
import {
  FinancialMovement,
  MovementConcept,
  MovementType,
  type AccountReference,
} from '@/modules/financial-movements/entities/financial-movement.entity';
import { Customer } from '@/modules/customers/entities/customer.entity';
import { Delivery, type DeliveryPaymentMethod } from '@/modules/deliveries/entities/delivery.entity';
import { DeliveryCompany } from '@/modules/deliveries/entities/delivery-company.entity';
import { Employee, EmployeeRole } from '@/modules/employees/entities/employee.entity';
import { ensureMirrorUserForEmployee } from '@/modules/employees/internal/ensure-mirror-user-for-employee.helper';
import { Expense } from '@/modules/expenses/entities/expense.entity';
import {
  FixedExpense,
  type FixedExpensePeriodUnit,
} from '@/modules/fixed-expenses/entities/fixed-expense.entity';
import {
  FixedExpensePeriod,
  type FixedExpensePeriodStatus,
} from '@/modules/fixed-expenses/entities/fixed-expense-period.entity';
import { Packaging } from '@/modules/packagings/entities/packaging.entity';
import { Product } from '@/modules/products/entities/product.entity';
import {
  InventoryMovement,
  type InventoryMovementDirection,
  type InventoryMovementReason,
  type InventoryMovementReferenceType,
} from '@/modules/products/entities/inventory-movement.entity';
import { ProductPrice } from '@/modules/products/entities/product-price.entity';
import {
  ProductCostHistory,
  ProductCostHistoryDerivedFrom,
  ProductCostHistoryEvent,
} from '@/modules/product-history/entities/product-cost-history.entity';
import { ProductPriceHistory } from '@/modules/product-history/entities/product-price-history.entity';
import { Purchase } from '@/modules/purchases/entities/purchase.entity';
import { PurchaseLine } from '@/modules/purchases/entities/purchase-line.entity';
import {
  PurchaseCredit,
  PurchaseCreditStatus,
} from '@/modules/purchases/entities/purchase-credit.entity';
import { PurchasePayment } from '@/modules/purchases/entities/purchase-payment.entity';
import { SaleInvoice } from '@/modules/sales/entities/sale-invoice.entity';
import { SaleInvoiceLine } from '@/modules/sales/entities/sale-invoice-line.entity';
import { SalePayment } from '@/modules/sales/entities/sale-payment.entity';
import { SaleCredit, SaleCreditStatus } from '@/modules/sales/entities/sale-credit.entity';
import { Supplier } from '@/modules/suppliers/entities/supplier.entity';
import { CreateDefaultTicketSettingsAction } from '@/modules/ticket-settings/actions/create-default-ticket-settings.action';
import {
  TicketSetting,
  TicketSettingType,
} from '@/modules/ticket-settings/entities/ticket-setting.entity';
import { formatTicketNumber } from '@/modules/ticket-settings/internal/format-ticket-number';
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
 * Lee `created_at` y `updated_at` de una fila del ZIP. Si `updated_at` falta
 * pero `created_at` está presente, espeja `updated_at = created_at` para no
 * dejar la columna en `now()` (que dispararía el bug de "fecha hoy" del
 * default de `@UpdateDateColumn`).
 *
 * Para tablas de movimientos (sales, credit_notes, purchases, expenses, ...)
 * un `created_at === null` señala una fila inválida que debe descartarse con
 * warning — el caller chequea ese caso ANTES de llamar a `repo.create()`.
 *
 * Para maestros (categories, customers, etc.) un `created_at === null` es
 * tolerable: el caller usa el spread condicional para omitir ambos campos y
 * dejar que el default de la DB (`now()`) actúe.
 */
function readZipDates(row: ZipRow): { created_at: Date | null; updated_at: Date | null } {
  const createdAt = asNullableDate(row.created_at);
  const updatedAt = asNullableDate(row.updated_at) ?? createdAt;
  return { created_at: createdAt, updated_at: updatedAt };
}

/**
 * Orden de borrado de TODAS las tablas con `company_id`, de hijo a padre.
 *
 * --------------------------------------------------------------------------
 * Por qué este orden exacto
 * --------------------------------------------------------------------------
 *
 * El reemplazo automático (re-subir el dump de un negocio ya migrado) borra
 * los datos HIJOS del tenant antes de recargar, pero CONSERVA la fila
 * `companies` y el `user` owner (sus ids no cambian — ver `wipeCompanyChildren`).
 * Hay FKs `RESTRICT` entre tablas no-company (p.ej. `purchases → suppliers`,
 * `credit_notes → sale_invoices`,
 * `carrier_payments → carrier_credits|banks|wallets|financial_movements`) que
 * obligan a borrar primero al que referencia.
 *
 * `RESTRICT` en Postgres se evalúa POR FILA de inmediato (no difiere a fin de
 * statement como `NO ACTION`), por eso el orden importa incluso dentro de un
 * mismo `DELETE`. `products` se auto-referencia (`parent_id`), así que se
 * trata aparte en `wipeCompanyChildren` (NULL-out + delete) para soportar
 * jerarquías de combos de cualquier profundidad.
 *
 * `users` está en la lista por completitud, pero `wipeCompanyChildren` lo OMITE
 * (el owner se conserva/actualiza en `upsertOwnerUser`). Si en el futuro se
 * agrega una tabla con `company_id`, debe añadirse aquí: de lo contrario sus
 * filas viejas sobrevivirían a la recarga y se duplicarían.
 */
const COMPANY_SCOPED_DELETE_ORDER: readonly string[] = [
  'carrier_payments',
  'product_price_history',
  'cash_register_logs',
  'product_cost_history',
  'carrier_credits',
  'correction_sources',
  // `deliveries` antes que `delivery_companies` (FK RESTRICT) y antes que
  // `sale_invoices` (su `invoice_id` es ON DELETE SET NULL: borrarlo primero
  // evita un UPDATE en cascada innecesario al limpiar las ventas).
  'deliveries',
  'delivery_companies',
  'credit_note_lines',
  'credit_notes',
  'sale_payments',
  'sale_credits',
  'sale_invoice_lines',
  'sale_invoices',
  'purchase_payments',
  'purchase_lines',
  'purchase_credits',
  'inventory_movements',
  'purchases',
  'product_prices',
  'fixed_expense_periods',
  // `products` se borra manualmente entre product_prices y el resto (self-FK).
  'products',
  'fixed_expenses',
  'expenses',
  'financial_movements',
  'app_alerts',
  'categories',
  'packagings',
  'suppliers',
  'carriers',
  'banks',
  'customers',
  'wallets',
  'ticket_settings',
  'app_settings',
  'alert_configs',
  'cash_registers',
  'employees',
  'users',
];

/**
 * Inserta una company y un user owner. Si el negocio ya fue migrado (mismo
 * email de owner o mismo document_number) se hace un reemplazo con `company_id`
 * ESTABLE: se conservan la fila `companies` y el `user` owner (mismos ids, para
 * que sesiones/JWT y referencias externas sigan válidas), se actualizan con los
 * datos del dump y se reemplazan SOLO los datos hijos —scoped a su company_id—,
 * todo dentro de la misma transacción (reemplazo atómico: o todo, o nada).
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

    const selectedModules = resolveSelectedModules(selectedInput);
    const inserted: Record<string, number> = {};
    const warnings: string[] = [];
    let replacedCompanyId: string | null = null;

    const { companyIdReal, userIdReal } = await this.dataSource.transaction(async (manager) => {
      // 0. Reemplazo automático con company_id ESTABLE: si este negocio ya fue
      //    migrado (mismo email de owner o, en su defecto, mismo
      //    document_number) NO rotamos el id. Conservamos la fila `companies` y
      //    el `user` owner (mismos ids, para que sesiones/JWT sigan válidas),
      //    los actualizamos con el dump y borramos solo los datos hijos para
      //    reinsertarlos. Todo en esta misma TX: o se reemplaza completo, o
      //    nada (rollback).
      const existingId = await this.resolveExistingCompanyId(manager, documentNumber, email);

      let company: Company;
      let user: User;
      if (existingId !== null) {
        await this.wipeCompanyChildren(manager, existingId);
        company = await this.updateCompany(manager, existingId, companyRow);
        user = await this.upsertOwnerUser(manager, existingId, userRow);
        replacedCompanyId = existingId;
        warnings.push(
          `Reemplazo automático: la empresa ya existía (company_id=${existingId}). ` +
            `Se conservó su company_id y su usuario owner; se reemplazaron todos ` +
            `sus datos por los del dump.`,
        );
      } else {
        // 1. Insertar Company.
        company = await this.insertCompany(manager, companyRow);
        // 2. Insertar User owner (password ya hasheado en argon2id).
        user = await this.insertUser(manager, userRow, company.id);
      }
      inserted.companies = 1;
      inserted.users = 1;

      // 3-6. Seeds + pipeline de inserción por módulo + persistencia de folios.
      //      Extraído a `importModulesIntoCompany` para reutilizarlo desde el
      //      endpoint de restore (que NO crea/resuelve empresa: usa el
      //      company_id del JWT). El flujo admin queda equivalente: tras
      //      crear/actualizar company + user, delegamos al mismo método.
      const ownerFullName = `${user.name} ${user.lastname}`.trim();
      await this.importModulesIntoCompany(manager, {
        zip,
        companyId: company.id,
        ownerUserId: user.id,
        ownerFullName,
        selectedModules,
        inserted,
        warnings,
      });

      return { companyIdReal: company.id, userIdReal: user.id };
    });

    // El manifest del ZIP también lleva warnings — los anexamos al final.
    for (const w of zip.manifest.warnings) {
      warnings.push(w);
    }

    return {
      company_id_real: String(companyIdReal),
      user_id_real: String(userIdReal),
      replaced_company_id: replacedCompanyId !== null ? String(replacedCompanyId) : null,
      inserted,
      warnings,
      duration_ms: Date.now() - startedAt,
    };
  }

  // ---------------------------------------------------------------------
  // Pipeline reutilizable: seeds + inserción por módulo + folios
  // ---------------------------------------------------------------------

  /**
   * Pipeline de carga de datos de negocio dentro de un `company_id` YA
   * resuelto (creado, actualizado o —en el restore— el del JWT). Es agnóstico
   * del origen del `companyId`: solo necesita que la fila `companies` y el
   * `user` owner existan antes de llamarlo.
   *
   * Pasos (todos dentro de la transacción del `manager` recibido):
   *   1. (Opcional, `opts.wipe`) `wipeCompanyChildren` — borra los datos hijos
   *      del tenant conservando `companies` y el owner. El flujo admin ya lo
   *      ejecuta condicionalmente aguas arriba (solo en reemplazo), por eso
   *      pasa `wipe: false`; el restore pasa `wipe: true` porque la empresa
   *      cloud siempre preexiste y hay que limpiar antes de recargar.
   *   2. `seedEssentials` — wallet, ticket_settings (6), cash_register,
   *      app_settings (2), alert_configs (1).
   *   3. Carga de `ticket_settings` para leer prefix/suffix al renumerar.
   *   4. Loop `insertTable()` por módulo en orden topológico, stampando
   *      `company_id`/`created_by_id` del tenant y remapeando IDs locales.
   *   5. Persistencia del `current_number` final de cada `ticket_setting`.
   *
   * Muta `opts.inserted` (conteo por tabla) y `opts.warnings` in-place: el
   * caller comparte esas referencias y arma el `MigrationSummaryDto` al final.
   */
  async importModulesIntoCompany(
    manager: EntityManager,
    opts: {
      zip: ParsedZip;
      companyId: string;
      ownerUserId: string;
      ownerFullName: string;
      selectedModules: SelectableModule[];
      inserted: Record<string, number>;
      warnings: string[];
      wipe?: boolean;
    },
  ): Promise<void> {
    const { zip, companyId, ownerUserId, ownerFullName, selectedModules, inserted, warnings } =
      opts;

    // 1. (Opcional) Borrado de datos hijos del tenant. Solo en restore: el
    //    flujo admin ya wipeó condicionalmente en `execute` antes de llegar
    //    aquí, así que NO debe re-wipear (pasa wipe=false / undefined).
    if (opts.wipe === true) {
      await this.wipeCompanyChildren(manager, companyId);
    }

    // 2. Seeds esenciales.
    const seeds = await seedEssentials(
      {
        manager,
        companyId: Number(companyId),
        ownerUserId: Number(ownerUserId),
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

    // 3. Cargar los ticket_settings recién sembrados (uno por tipo) para
    //    poder leer su prefix/suffix al renumerar ventas/notas/compras.
    const tsRows = await manager.getRepository(TicketSetting).find({
      where: { company_id: companyId },
    });
    const tsByType = new Map<TicketSettingType, TicketSetting>();
    for (const ts of tsRows) {
      tsByType.set(ts.ticket_type, ts);
    }
    const counters: Record<TicketSettingType, number> = {
      [TicketSettingType.ORDER]: 0,
      [TicketSettingType.SALE]: 0,
      [TicketSettingType.CREDIT_NOTE]: 0,
      [TicketSettingType.DEBIT_NOTE]: 0,
      [TicketSettingType.PURCHASE]: 0,
      [TicketSettingType.PURCHASE_PAYMENT]: 0,
    };

    // 4. Procesar módulos seleccionados en orden topológico.
    const ctx: ImportCtx = {
      manager,
      zip,
      remapper: new IdRemapper(),
      companyIdReal: companyId,
      userIdReal: ownerUserId,
      ownerFullName,
      defaultWalletId: seeds.walletId,
      defaultCashRegisterId: seeds.cashRegisterId,
      warnings,
      counters,
      tsByType,
    };

    // 4.0 Pre-poblar el MAPA DE USUARIOS offline→cloud (namespace 'users' del
    //     remapper) ANTES del loop de módulos. Es la fuente de verdad para
    //     remapear `created_by_id` en TODAS las tablas de movimiento. Debe
    //     correr SIEMPRE, incluso si el módulo `employees` no fue seleccionado
    //     (p.ej. seleccionan `sales` sin `employees`), para que `created_by_id`
    //     resuelva consistentemente al owner por defecto.
    const employeesSelected = selectedModules.includes('employees');
    this.populateUserMap(ctx, employeesSelected);

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

    // 5. Persistir el `current_number` final de cada `ticket_setting`
    //    cuyos folios consumimos. Tipos sin emisión quedan en 0 (seed).
    const typesWithEmission: TicketSettingType[] = [
      TicketSettingType.ORDER,
      TicketSettingType.SALE,
      TicketSettingType.CREDIT_NOTE,
      TicketSettingType.DEBIT_NOTE,
      TicketSettingType.PURCHASE,
      TicketSettingType.PURCHASE_PAYMENT,
    ];
    for (const type of typesWithEmission) {
      const finalCounter = ctx.counters[type];
      if (finalCounter === 0) {
        continue;
      }
      await manager
        .createQueryBuilder()
        .update(TicketSetting)
        .set({ current_number: finalCounter, updated_at: () => 'now()' })
        .where('company_id = :c AND ticket_type = :t', {
          c: ctx.companyIdReal,
          t: type,
        })
        .execute();
    }
  }

  // ---------------------------------------------------------------------
  // Resolución de empresa existente + wipe (reemplazo automático)
  // ---------------------------------------------------------------------

  /**
   * Resuelve el `company_id` de un negocio ya migrado para reemplazarlo, o
   * `null` si es una carga nueva.
   *
   * La identidad fiable es el EMAIL del owner: `users.email` es UNIQUE global
   * (`idx_users_email_unique`), así que un email existente apunta a exactamente
   * una company —la que se migró antes desde este mismo negocio—. Si el email
   * no existe (p.ej. el owner cambió de correo entre dumps) se usa el
   * `document_number` como respaldo. NO es UNIQUE (ver Company.document_number),
   * por eso es solo fallback: tomamos la primera coincidencia.
   */
  private async resolveExistingCompanyId(
    manager: EntityManager,
    documentNumber: string | null,
    email: string,
  ): Promise<string | null> {
    if (email !== '') {
      const user = await manager.getRepository(User).findOne({ where: { email } });
      if (user?.company_id != null) {
        return user.company_id;
      }
    }

    if (documentNumber !== null && documentNumber.trim() !== '') {
      const company = await manager
        .getRepository(Company)
        .createQueryBuilder('c')
        .where('c.document_number = :doc', { doc: documentNumber })
        .orderBy('c.id', 'ASC')
        .getOne();
      if (company) {
        return company.id;
      }
    }

    return null;
  }

  /**
   * Elimina los datos HIJOS del tenant `companyId`, pero CONSERVA la fila
   * `companies` y el `user` owner (sus ids NO cambian). Se ejecuta DENTRO de la
   * TX del import; si la recarga posterior falla, el rollback restaura todo.
   *
   * Mantener estables el company_id y el owner hace que una re-migración sea
   * transparente: el login firma el `company_id` dentro del JWT y lo lee de ahí
   * sin re-consultar la BD, así que rotar el id dejaría a las sesiones activas
   * apuntando a un tenant inexistente (tablas "vacías"). El borrado es
   * estrictamente scoped por `company_id` (multi-tenant: jamás toca otra
   * empresa) y en orden hijo→padre (`COMPANY_SCOPED_DELETE_ORDER`) para respetar
   * los FK `RESTRICT`.
   *
   * `users` se OMITE (el owner se conserva/actualiza en `upsertOwnerUser`). Los
   * seeds borrados aquí (ticket_settings, wallets, cash_registers, app_settings,
   * alert_configs) los recrea `seedEssentials` tras el update.
   */
  private async wipeCompanyChildren(manager: EntityManager, companyId: string): Promise<void> {
    for (const table of COMPANY_SCOPED_DELETE_ORDER) {
      if (table === 'users') {
        // El owner se conserva (id estable) y se actualiza en upsertOwnerUser.
        continue;
      }
      if (table === 'products') {
        // `products.parent_id` es self-FK RESTRICT. Romper el vínculo padre
        // antes de borrar permite eliminar combos anidados de cualquier
        // profundidad en un solo DELETE.
        await manager.query('UPDATE "products" SET parent_id = NULL WHERE company_id = $1', [
          companyId,
        ]);
        await manager.query('DELETE FROM "products" WHERE company_id = $1', [companyId]);
        continue;
      }
      await manager.query(`DELETE FROM "${table}" WHERE company_id = $1`, [companyId]);
    }
    // NO se borra la fila `companies`: se actualiza en sitio (updateCompany).
  }

  /**
   * Actualiza en sitio la fila `companies` existente con los datos del dump,
   * conservando su `id`. Si por una inconsistencia no existe, cae a insertar.
   */
  private async updateCompany(
    manager: EntityManager,
    companyId: string,
    row: ZipRow,
  ): Promise<Company> {
    const repo = manager.getRepository(Company);
    const existing = await repo.findOne({ where: { id: companyId } });
    if (existing === null) {
      return this.insertCompany(manager, row);
    }
    existing.name = asString(row.name).trim() || '(Sin nombre)';
    existing.document_number = asNullableString(row.document_number);
    existing.balance = asNumber(row.balance);
    existing.address = asNullableString(row.address);
    existing.email = asNullableString(row.email);
    existing.phone_number = asNullableString(row.phone_number);
    existing.break_even_amount = asNumber(row.break_even_amount);
    existing.break_even_period_days =
      row.break_even_period_days !== undefined ? Number(row.break_even_period_days) : 30;
    return repo.save(existing);
  }

  /**
   * Conserva el `user` owner del tenant (mismo id, para no invalidar tokens) y
   * lo actualiza con los datos del dump. Si no existe un owner para la company
   * (inconsistencia), inserta uno nuevo. El password viene ya hasheado
   * (argon2id) desde el ZIP — NO se re-hashea.
   */
  private async upsertOwnerUser(
    manager: EntityManager,
    companyId: string,
    row: ZipRow,
  ): Promise<User> {
    const repo = manager.getRepository(User);
    const existing = await repo.findOne({
      where: { company_id: companyId, type: 'owner' as User['type'] },
      order: { id: 'ASC' },
    });
    if (existing === null) {
      return this.insertUser(manager, row, companyId);
    }
    existing.name = asString(row.name).trim() || 'Owner';
    existing.lastname = asString(row.lastname).trim() || '';
    existing.email = asString(row.email).trim().toLowerCase();
    existing.password = asString(row.password);
    existing.balance = asNumber(row.balance);
    return repo.save(existing);
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
      case 'sale_credits':
        return this.insertSaleCredits(ctx, rows);
      case 'sale_payments':
        return this.insertSalePayments(ctx, rows);
      case 'credit_notes':
        return this.insertCreditNotes(ctx, rows);
      case 'credit_note_lines':
        return this.insertCreditNoteLines(ctx, rows);
      case 'correction_sources':
        return this.insertCorrectionSources(ctx, rows);
      case 'purchases':
        return this.insertPurchases(ctx, rows);
      case 'purchase_lines':
        return this.insertPurchaseLines(ctx, rows);
      case 'purchase_credits':
        return this.insertPurchaseCredits(ctx, rows);
      case 'purchase_payments':
        return this.insertPurchasePayments(ctx, rows);
      case 'carrier_credits':
        return this.insertCarrierCredits(ctx, rows);
      case 'expenses':
        return this.insertExpenses(ctx, rows);
      case 'fixed_expenses':
        return this.insertFixedExpenses(ctx, rows);
      case 'fixed_expense_periods':
        return this.insertFixedExpensePeriods(ctx, rows);
      case 'delivery_companies':
        return this.insertDeliveryCompanies(ctx, rows);
      case 'deliveries':
        return this.insertDeliveries(ctx, rows);
      case 'product_cost_history':
        return this.insertProductCostHistory(ctx, rows);
      case 'product_price_history':
        return this.insertProductPriceHistory(ctx, rows);
      case 'financial_movements':
        return this.insertFinancialMovements(ctx, rows);
      case 'carrier_payments':
        return this.insertCarrierPayments(ctx, rows);
      case 'inventory_movements':
        return this.insertInventoryMovements(ctx, rows);
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

      const { created_at, updated_at } = readZipDates(row);
      const saved = await repo.save(
        repo.create({
          company_id: ctx.companyIdReal,
          name: final,
          is_archived: asBoolean(row.is_archived),
          ...(created_at !== null
            ? { created_at, updated_at: updated_at ?? created_at }
            : {}),
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

      const { created_at, updated_at } = readZipDates(row);
      const saved = await repo.save(
        repo.create({
          company_id: ctx.companyIdReal,
          name: final,
          value: asNumber(row.value),
          is_archived: asBoolean(row.is_archived),
          created_by: asNullableString(row.created_by) ?? ctx.ownerFullName,
          created_by_id: this.remapUserId(ctx, row.created_by_id),
          ...(created_at !== null
            ? { created_at, updated_at: updated_at ?? created_at }
            : {}),
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
    // sku_code / bar_code tienen índices UNIQUE PARCIALES per-company que solo
    // aplican a productos ACTIVOS (is_archived = false). Rastreamos los códigos
    // de activos ya vistos para desduplicar (ver bloque dentro del loop).
    const seenSku = new Set<string>();
    const seenBar = new Set<string>();
    let count = 0;
    let dupSku = 0;
    let dupBar = 0;
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
      // Offline usa `archived`; cloud usa `is_archived`.
      const isArchived = asBoolean(row.is_archived ?? row.archived);

      // El backup (origen SQLite de placepos) puede traer sku_code/bar_code
      // repetidos entre productos activos. El índice único parcial solo cubre
      // activos y es sensible a mayúsculas/espacios, así que comparamos el
      // valor EXACTO que se insertaría. Ante un duplicado, anulamos el código
      // del segundo en adelante para no abortar toda la transacción del restore.
      let skuCode = asNullableString(row.sku_code);
      if (skuCode !== null && !isArchived) {
        if (seenSku.has(skuCode)) {
          skuCode = null;
          dupSku++;
        } else {
          seenSku.add(skuCode);
        }
      }
      let barCode = asNullableString(row.bar_code);
      if (barCode !== null && !isArchived) {
        if (seenBar.has(barCode)) {
          barCode = null;
          dupBar++;
        } else {
          seenBar.add(barCode);
        }
      }

      const { created_at, updated_at } = readZipDates(row);
      const saved = await repo.save(
        repo.create({
          company_id: ctx.companyIdReal,
          name: final,
          description: asNullableString(row.description),
          product_type: productType as Product['product_type'],
          parent_id: ctx.remapper.getOptional('products', asNullableString(row.parent_id)),
          sku_code: skuCode,
          bar_code: barCode,
          packaging_id: ctx.remapper.getOptional('packagings', asNullableString(row.packaging_id)),
          category_id: ctx.remapper.getOptional('categories', asNullableString(row.category_id)),
          cost: asNumber(row.cost),
          stock: asNumber(row.stock),
          is_purchasable: asBoolean(row.is_purchasable, true),
          hash: asNullableString(row.hash),
          image: asNullableString(row.image),
          show_in_pos: asBoolean(row.show_in_pos, true),
          is_archived: isArchived,
          created_by: asNullableString(row.created_by) ?? ctx.ownerFullName,
          created_by_id: this.remapUserId(ctx, row.created_by_id),
          updated_by: asNullableString(row.updated_by),
          updated_by_id: null,
          ...(created_at !== null
            ? { created_at, updated_at: updated_at ?? created_at }
            : {}),
        }),
      );
      ctx.remapper.set('products', localId, saved.id);
      count++;
    }
    if (dupSku > 0) {
      ctx.warnings.push(
        `products: ${dupSku} sku_code duplicados anulados para respetar la unicidad per-company`,
      );
    }
    if (dupBar > 0) {
      ctx.warnings.push(
        `products: ${dupBar} bar_code duplicados anulados para respetar la unicidad per-company`,
      );
    }
    return count;
  }

  private async insertProductPrices(ctx: ImportCtx, rows: ZipRow[]): Promise<number> {
    const repo = ctx.manager.getRepository(ProductPrice);
    // Máximo de precios por producto que acepta el POS (el configurador topa en 5).
    const MAX_PRODUCT_PRICES = 5;
    const pricesByProduct = new Map<string, number>();
    let count = 0;
    let skipped = 0;
    let skippedInvalid = 0;
    let skippedCap = 0;
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
      // Ignora precios en 0 o negativos: es regla de negocio y, además, el
      // CHECK `sale_price >= 0` abortaría toda la TX del import ante un negativo.
      const salePrice = asNumber(row.sale_price);
      if (salePrice <= 0) {
        skippedInvalid++;
        continue;
      }
      // Topa en MAX_PRODUCT_PRICES por producto (defensa ante ZIPs antiguos; el
      // transform de placepos ya recorta en origen).
      const current = pricesByProduct.get(productIdReal) ?? 0;
      if (current >= MAX_PRODUCT_PRICES) {
        skippedCap++;
        continue;
      }
      const { created_at, updated_at } = readZipDates(row);
      const saved = await repo.save(
        repo.create({
          company_id: ctx.companyIdReal,
          product_id: productIdReal,
          name: asString(row.name) || 'Base',
          sale_price: salePrice,
          profit: Math.max(0, asNumber(row.profit)),
          margin: Math.max(0, asNumber(row.margin)),
          iva_percentage: asNumber(row.iva_percentage),
          created_by: asNullableString(row.created_by) ?? ctx.ownerFullName,
          created_by_id: this.remapUserId(ctx, row.created_by_id),
          ...(created_at !== null
            ? { created_at, updated_at: updated_at ?? created_at }
            : {}),
        }),
      );
      ctx.remapper.set('product_prices', localId, saved.id);
      pricesByProduct.set(productIdReal, current + 1);
      count++;
    }
    if (skipped > 0) {
      ctx.warnings.push(`product_prices: ${skipped} filas descartadas por product_id no resoluble`);
    }
    if (skippedInvalid > 0) {
      ctx.warnings.push(`product_prices: ${skippedInvalid} precios descartados por sale_price <= 0`);
    }
    if (skippedCap > 0) {
      ctx.warnings.push(
        `product_prices: ${skippedCap} precios descartados por exceder el máximo de ${MAX_PRODUCT_PRICES} por producto`,
      );
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
      const { created_at, updated_at } = readZipDates(row);
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
          created_by_id: this.remapUserId(ctx, row.created_by_id),
          ...(created_at !== null
            ? { created_at, updated_at: updated_at ?? created_at }
            : {}),
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
      const { created_at, updated_at } = readZipDates(row);
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
          created_by_id: this.remapUserId(ctx, row.created_by_id),
          ...(created_at !== null
            ? { created_at, updated_at: updated_at ?? created_at }
            : {}),
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

      const { created_at, updated_at } = readZipDates(row);
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
          created_by_id: this.remapUserId(ctx, row.created_by_id),
          ...(created_at !== null
            ? { created_at, updated_at: updated_at ?? created_at }
            : {}),
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

      const { created_at, updated_at } = readZipDates(row);
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
          created_by_id: this.remapUserId(ctx, row.created_by_id),
          ...(created_at !== null
            ? { created_at, updated_at: updated_at ?? created_at }
            : {}),
        }),
      );
      ctx.remapper.set('carriers', localId, saved.id);
      count++;
    }
    return count;
  }

  // ---------------------------------------------------------------------
  // Mapa de usuarios offline→cloud (remapeo de created_by_id)
  // ---------------------------------------------------------------------

  /**
   * Pre-puebla el namespace `'users'` del remapper: `offline users.id` →
   * `cloud users.id`, fuente de verdad para remapear `created_by_id` en todas
   * las tablas de movimiento.
   *
   * --------------------------------------------------------------------------
   * Reglas de mapeo
   * --------------------------------------------------------------------------
   *
   *   - Default: TODO `users.id` offline → `ctx.userIdReal` (owner cloud). Esto
   *     cubre al owner y al `superadmin` offline: el cloud NO tiene superadmin
   *     por tenant, así que sus movimientos se atribuyen al owner (la única
   *     identidad "global" del tenant). Si el dump tuviera más de un owner, el
   *     extra también cae al owner cloud único.
   *
   *   - Override por empleado con login: los `user_id` (offline) de empleados
   *     que serán espejados (`login_enabled=true` o `user_id != null`, con
   *     credenciales) se EXCLUYEN del default aquí y los mapea `insertEmployees`
   *     al `users.id` del espejo cloud recién creado. Así un mismo id offline
   *     nunca se registra dos veces en el remapper (IdRemapper.set lanza ante
   *     duplicados).
   *
   * Si el módulo `employees` NO fue seleccionado, no se crearán espejos, así
   * que TODOS los `users.id` (incluidos los de empleados) caen al owner: es el
   * comportamiento seguro previo (sin empleados migrados no hay a quién
   * atribuir las ventas salvo el owner).
   */
  private populateUserMap(ctx: ImportCtx, employeesSelected: boolean): void {
    // 1. Recolectar los user_id offline de empleados que SERÁN espejados.
    //    Solo si el módulo employees está seleccionado (de lo contrario no se
    //    crean espejos y esos ids deben caer al owner).
    const mirroredOfflineUserIds = new Set<string>();
    if (employeesSelected) {
      for (const emp of ctx.zip.tables.get('employees') ?? []) {
        const username = asNullableString(emp.username);
        const password = asNullableString(emp.password);
        const hasCredentials =
          username !== null && username.trim() !== '' && password !== null && password !== '';
        const loginEnabled = asBoolean(emp.login_enabled) && hasCredentials;
        const offlineUserId = asNullableString(emp.user_id);
        const willMirror = hasCredentials && (loginEnabled || offlineUserId !== null);
        if (willMirror && offlineUserId !== null) {
          mirroredOfflineUserIds.add(offlineUserId);
        }
      }
    }

    // 2. Default: cada users.id offline → owner cloud, salvo los reservados a
    //    espejos (que poblará insertEmployees).
    let toOwner = 0;
    for (const userRow of ctx.zip.tables.get('users') ?? []) {
      const offlineUserId = asNullableString(userRow.id);
      if (offlineUserId === null) {
        continue;
      }
      if (mirroredOfflineUserIds.has(offlineUserId)) {
        continue; // lo mapea insertEmployees al espejo.
      }
      if (!ctx.remapper.has('users', offlineUserId)) {
        ctx.remapper.set('users', offlineUserId, ctx.userIdReal);
        toOwner++;
      }
    }
    if (toOwner > 0) {
      ctx.warnings.push(
        `users: ${toOwner} usuario(s) offline (owner/superadmin/empleados sin login) mapeados al owner cloud para created_by_id`,
      );
    }
  }

  /**
   * Traduce un `created_by_id` offline al `users.id` cloud correcto vía el mapa
   * `'users'` del remapper. Si el id no está mapeado (p.ej. un user_id offline
   * inesperado), cae al owner cloud — nunca deja `created_by_id` colgando.
   */
  private remapUserId(ctx: ImportCtx, offlineCreatedById: unknown): string {
    const key = asNullableString(offlineCreatedById);
    if (key === null) {
      return ctx.userIdReal;
    }
    return ctx.remapper.getOptional('users', key) ?? ctx.userIdReal;
  }

  /**
   * `employees` — sub-usuarios del POS. A diferencia de la versión previa
   * (que anulaba credenciales y dejaba `user_id=null`), aquí MIGRAMOS las
   * credenciales reales del dump y, para los empleados con login, creamos su
   * User ESPEJO cloud enlazando `employees.user_id`.
   *
   * --------------------------------------------------------------------------
   * Por qué importa para la atribución de ventas
   * --------------------------------------------------------------------------
   *
   * Offline, `sale_invoices.created_by_id` apunta al `users.id` del vendedor
   * (su User espejo si es empleado). El POS cloud, al loguear al empleado, lo
   * resuelve vía `ensureMirrorUserForEmployee`, que REUSA el espejo si
   * `employees.user_id` ya está seteado. Por eso, si aquí creamos el espejo y
   * fijamos `employees.user_id`, el login posterior obtiene EXACTAMENTE el
   * mismo `users.id` que pusimos en las ventas migradas → el empleado ve sus
   * ventas. Además registramos en el mapa `offline employees.user_id →
   * cloud mirror.id` para que `remapUserId` lo aplique a `created_by_id`.
   *
   * --------------------------------------------------------------------------
   * Credenciales
   * --------------------------------------------------------------------------
   *
   * `username`/`password` (hash argon2id) y `login_enabled` se copian tal cual
   * del ZIP. El hash es compatible con `argon2.verify` de pos_api (mismo
   * algoritmo PHC). El espejo reusa ese mismo hash (no se re-hashea).
   *
   * La migración hace wipe del tenant antes de cargar, así que dentro de la
   * company no hay colisión de `employees.username`. El email sintético del
   * espejo lleva `companyId` (ver `buildMirrorEmail`), evitando colisiones
   * cross-tenant; `ensureMirrorUserForEmployee` traduce un 23505 residual a
   * `ConflictException`.
   */
  private async insertEmployees(ctx: ImportCtx, rows: ZipRow[]): Promise<number> {
    const repo = ctx.manager.getRepository(Employee);
    let count = 0;
    let mirrors = 0;
    for (const row of rows) {
      const localId = asString(row.id);
      // role: 'manager' | 'employee'.
      const role = row.role === 'manager' ? EmployeeRole.MANAGER : EmployeeRole.EMPLOYEE;

      // Credenciales del dump. El CHECK chk_employees_login_requires_credentials
      // exige username+password no vacíos cuando login_enabled=true; si el dump
      // viniera incoherente (login=true sin credenciales), degradamos a
      // login_enabled=false para no abortar la TX del import.
      const username = asNullableString(row.username);
      const password = asNullableString(row.password);
      const hasCredentials =
        username !== null && username.trim() !== '' && password !== null && password !== '';
      const loginEnabled = asBoolean(row.login_enabled) && hasCredentials;

      const { created_at, updated_at } = readZipDates(row);
      const saved = await repo.save(
        repo.create({
          company_id: ctx.companyIdReal,
          name: asString(row.name).trim() || 'Empleado',
          phone: asNullableString(row.phone),
          email: asNullableString(row.email),
          address: asNullableString(row.address),
          role,
          login_enabled: loginEnabled,
          username: hasCredentials ? username : null,
          password: hasCredentials ? password : null,
          is_archived: asBoolean(row.is_archived),
          created_by: asNullableString(row.created_by) ?? ctx.ownerFullName,
          // `employees.created_by_id` = id del OWNER que creó al empleado
          // (campo informacional), NO el vendedor. Permanece en el owner cloud.
          created_by_id: ctx.userIdReal, // owner creador (no remapear)
          user_id: null,
          ...(created_at !== null
            ? { created_at, updated_at: updated_at ?? created_at }
            : {}),
        }),
      );
      ctx.remapper.set('employees', localId, saved.id);
      count++;

      // Crear el User espejo y registrar el mapeo offline→cloud SOLO para
      // empleados que (a) tienen credenciales válidas y (b) en el dump
      // estaban habilitados o ya tenían un User espejo (user_id != null).
      // El segundo criterio cubre el empleado cuyas ventas históricas se
      // atribuyeron a su espejo aunque su login esté hoy revocado.
      const offlineUserId = asNullableString(row.user_id);
      const shouldMirror = hasCredentials && (loginEnabled || offlineUserId !== null);
      if (shouldMirror) {
        // ensureMirrorUserForEmployee es idempotente: si employee.user_id ya
        // estuviera seteado reusaría el espejo. Aquí siempre es null (recién
        // insertado), así que crea uno nuevo y muta saved.user_id in-memory.
        const mirror = await ensureMirrorUserForEmployee({
          manager: ctx.manager,
          employee: saved,
          companyId: Number(ctx.companyIdReal),
        });
        mirrors++;
        // Mapear el `users.id` OFFLINE del espejo (employees.user_id del ZIP)
        // al `users.id` CLOUD del espejo recién creado. Las ventas/compras/etc
        // migradas traen `created_by_id = ese user_id offline` y se remapearán
        // a `mirror.id` vía remapUserId(). Si el dump no trae user_id (login
        // habilitado sin espejo previo), no hay id offline que remapear: las
        // ventas de ese empleado caerán al owner (no había id estable offline).
        if (offlineUserId !== null && !ctx.remapper.has('users', offlineUserId)) {
          ctx.remapper.set('users', offlineUserId, mirror.id);
        }
      }
    }
    if (mirrors > 0) {
      ctx.warnings.push(
        `employees: ${mirrors} usuario(s) espejo creados para empleados con login (credenciales y atribución de ventas migradas)`,
      );
    }
    return count;
  }

  // ---------------------------------------------------------------------
  // Ventas
  // ---------------------------------------------------------------------

  private async insertSaleInvoices(ctx: ImportCtx, rows: ZipRow[]): Promise<number> {
    const repo = ctx.manager.getRepository(SaleInvoice);

    // 1. Filtrar filas sin `created_at` (movimientos sin fecha legítima se
    //    descartan — ver bug #2 del refactor).
    const dated: { row: ZipRow; createdAt: Date; updatedAt: Date | null }[] = [];
    let skippedNoDate = 0;
    for (const row of rows) {
      const { created_at, updated_at } = readZipDates(row);
      if (created_at === null) {
        skippedNoDate++;
        continue;
      }
      dated.push({ row, createdAt: created_at, updatedAt: updated_at });
    }

    // 2. Orden cronológico ASC para que los consecutivos respeten el orden
    //    histórico (la venta más antigua se queda con VTA-001).
    dated.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());

    // 3. Resolver prefijos del seed.
    const orderTs = ctx.tsByType.get(TicketSettingType.ORDER);
    const saleTs = ctx.tsByType.get(TicketSettingType.SALE);
    const orderPrefix = orderTs?.prefix ?? null;
    const orderSuffix = orderTs?.suffix ?? null;
    const salePrefix = saleTs?.prefix ?? null;
    const saleSuffix = saleTs?.suffix ?? null;

    let count = 0;
    for (const { row, createdAt, updatedAt } of dated) {
      const localId = asString(row.id);
      const ticketType = row.ticket_type === 'ORDER' ? 'ORDER' : 'SALE';
      const localCustomer = asNullableString(row.customer_id);
      const customerIdReal = ctx.remapper.getOptional('customers', localCustomer);

      // Tanto ORDER como SALE consumen el counter `ORDER` para `ticket_number`
      // (un pedido siempre nace ORDER y al confirmarse hereda su número).
      // Adicionalmente, SALE consume el counter `SALE` para `sale_number`.
      const orderNum = ++ctx.counters[TicketSettingType.ORDER];
      const ticketNumber = formatTicketNumber(orderPrefix, orderSuffix, orderNum);
      let saleNumber: string | null = null;
      if (ticketType === 'SALE') {
        const saleNum = ++ctx.counters[TicketSettingType.SALE];
        saleNumber = formatTicketNumber(salePrefix, saleSuffix, saleNum);
      }

      const saved = await repo.save(
        repo.create({
          company_id: ctx.companyIdReal,
          ticket_type: ticketType as SaleInvoice['ticket_type'],
          ticket_number: ticketNumber,
          sale_number: saleNumber,
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
          created_by_id: this.remapUserId(ctx, row.created_by_id),
          is_deleted: asBoolean(row.is_deleted),
          created_at: createdAt,
          updated_at: updatedAt ?? createdAt,
        }),
      );
      ctx.remapper.set('sale_invoices', localId, saved.id);
      count++;
    }

    if (skippedNoDate > 0) {
      ctx.warnings.push(
        `sale_invoices: ${skippedNoDate} filas descartadas por falta de created_at`,
      );
    }
    return count;
  }

  private async insertSaleInvoiceLines(ctx: ImportCtx, rows: ZipRow[]): Promise<number> {
    const repo = ctx.manager.getRepository(SaleInvoiceLine);
    let count = 0;
    let skipped = 0;
    let skippedNoDate = 0;
    for (const row of rows) {
      const { created_at } = readZipDates(row);
      if (created_at === null) {
        skippedNoDate++;
        continue;
      }
      // El backup nativo (placepos) usa `invoice_id`/`item_id` y `name`/`price`/
      // `cost`; el esquema cloud usa `sale_invoice_id`/`product_id` y
      // `description`/`unit_price`/`unit_cost`. Mapeamos offline→cloud con
      // fallback al nombre cloud (backups futuros). El offline no maneja IVA:
      // subtotal = total, iva = 0.
      const invoiceIdReal = ctx.remapper.getOptional(
        'sale_invoices',
        asNullableString(row.invoice_id ?? row.sale_invoice_id),
      );
      const productIdReal = ctx.remapper.getOptional(
        'products',
        asNullableString(row.item_id ?? row.product_id),
      );
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
          description:
            (asString(row.description) || asString(row.name)).trim() ||
            `Producto ${productIdReal}`,
          quantity,
          unit_price: Math.max(0, asNumber(row.unit_price ?? row.price)),
          unit_cost: Math.max(0, asNumber(row.unit_cost ?? row.cost)),
          subtotal: Math.max(0, asNumber(row.subtotal ?? row.total)),
          iva_percentage: asNumber(row.iva_percentage),
          iva_amount: Math.max(0, asNumber(row.iva_amount)),
          total: Math.max(0, asNumber(row.total)),
          profit: Math.max(0, asNumber(row.profit)),
          margin: Math.max(0, asNumber(row.margin)),
          created_at,
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
    if (skippedNoDate > 0) {
      ctx.warnings.push(
        `sale_invoice_lines: ${skippedNoDate} filas descartadas por falta de created_at`,
      );
    }
    return count;
  }

  /**
   * Créditos de venta (ventas a crédito). Su presencia es la que hace que el
   * profit y el recaudo distingan ventas de contado de ventas a crédito: las
   * queries del dashboard excluyen del profit base las facturas que tienen un
   * `sale_credit` (esas aportan vía abonos). Si no se importaran, las ventas a
   * crédito se contarían como contado y el profit del mes quedaría inflado.
   *
   * Particularidades del mapeo backup→cloud:
   *   - El backup usa `invoice_id` como FK (cloud: `sale_invoice_id`).
   *   - El backup NO guarda `customer_id` en el crédito (lo deriva de la
   *     factura); la entidad cloud lo exige NOT NULL, así que lo resolvemos
   *     desde el `customer_id` de la `sale_invoice` del propio ZIP.
   *   - Recalculamos `balance` y `status` a partir de `total_amount`/`paid_amount`
   *     para garantizar los CHECK de consistencia, sin depender de que los
   *     montos del backup cuadren al céntimo ni del enum de estado de origen
   *     (offline: PENDING/PARTIAL/PAID → cloud: PENDING/PARTIALLY_PAID/PAID).
   */
  private async insertSaleCredits(ctx: ImportCtx, rows: ZipRow[]): Promise<number> {
    const repo = ctx.manager.getRepository(SaleCredit);

    // customer_id por factura, tomado del propio ZIP de sale_invoices.
    const invoiceCustomer = new Map<string, string | null>();
    for (const inv of ctx.zip.tables.get('sale_invoices') ?? []) {
      invoiceCustomer.set(asString(inv.id), asNullableString(inv.customer_id));
    }

    const seenInvoices = new Set<string>();
    let count = 0;
    let skipped = 0;
    let skippedNoDate = 0;
    let skippedNoCustomer = 0;
    for (const row of rows) {
      const { created_at, updated_at } = readZipDates(row);
      if (created_at === null) {
        skippedNoDate++;
        continue;
      }
      const localInvoiceId = asNullableString(row.invoice_id);
      const invoiceIdReal = ctx.remapper.getOptional('sale_invoices', localInvoiceId);
      if (invoiceIdReal === null) {
        skipped++;
        continue;
      }
      // UNIQUE(company_id, sale_invoice_id): un crédito por factura.
      if (seenInvoices.has(invoiceIdReal)) {
        skipped++;
        continue;
      }

      const total = Math.max(0, asNumber(row.total_amount));
      if (total <= 0) {
        // CHECK chk_sale_credits_total_positive.
        skipped++;
        continue;
      }

      const localCustomerId =
        localInvoiceId !== null ? (invoiceCustomer.get(localInvoiceId) ?? null) : null;
      const customerIdReal = ctx.remapper.getOptional('customers', localCustomerId);
      if (customerIdReal === null) {
        skippedNoCustomer++;
        continue;
      }

      // balance/status recomputados para respetar los CHECK de consistencia.
      const paid = Math.min(Math.max(0, asNumber(row.paid_amount)), total);
      const balance = Math.round((total - paid) * 100) / 100;
      const status =
        paid <= 0
          ? SaleCreditStatus.PENDING
          : balance > 0
            ? SaleCreditStatus.PARTIALLY_PAID
            : SaleCreditStatus.PAID;

      const dueRaw = asNullableString(row.due_date);
      let dueDate: Date | null = null;
      if (dueRaw !== null) {
        const d = new Date(dueRaw);
        dueDate = Number.isNaN(d.getTime()) ? null : d;
      }

      await repo.save(
        repo.create({
          company_id: ctx.companyIdReal,
          sale_invoice_id: invoiceIdReal,
          customer_id: customerIdReal,
          total_amount: total,
          paid_amount: paid,
          balance,
          due_date: dueDate,
          status,
          created_at,
          updated_at: updated_at ?? created_at,
        }),
      );
      seenInvoices.add(invoiceIdReal);
      count++;
    }
    if (skippedNoDate > 0) {
      ctx.warnings.push(
        `sale_credits: ${skippedNoDate} filas descartadas por falta de created_at`,
      );
    }
    if (skipped > 0) {
      ctx.warnings.push(
        `sale_credits: ${skipped} créditos descartados (FK faltante, duplicado o total inválido)`,
      );
    }
    if (skippedNoCustomer > 0) {
      ctx.warnings.push(
        `sale_credits: ${skippedNoCustomer} créditos descartados por factura sin cliente`,
      );
    }
    return count;
  }

  private async insertSalePayments(ctx: ImportCtx, rows: ZipRow[]): Promise<number> {
    const repo = ctx.manager.getRepository(SalePayment);
    let count = 0;
    let skipped = 0;
    let skippedNoDate = 0;
    for (const row of rows) {
      const { created_at } = readZipDates(row);
      if (created_at === null) {
        skippedNoDate++;
        continue;
      }
      // El backup nativo (placepos) usa `invoice_id`; el esquema cloud usa
      // `sale_invoice_id`. Sin este mapeo, la FK no resolvía y se descartaban
      // TODOS los pagos (recaudo del día en 0).
      const invoiceIdReal = ctx.remapper.getOptional(
        'sale_invoices',
        asNullableString(row.invoice_id ?? row.sale_invoice_id),
      );
      if (invoiceIdReal === null) {
        skipped++;
        continue;
      }
      // El backup nativo (placepos) modela el monto pagado como `amount_paid`
      // (la tabla offline tiene amount_due/amount_paid/change_amount, NO
      // `amount`). La entidad cloud lo unifica en `amount`. Leer `row.amount`
      // dejaba el monto en 0 y descartaba TODOS los pagos → recaudo del día en
      // 0. Fallback a `amount` por si un backup futuro ya trae ese nombre.
      const amount = asNumber(row.amount_paid ?? row.amount);
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
          created_by_id: this.remapUserId(ctx, row.created_by_id),
          uuid: asNullableString(row.uuid),
          created_at,
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
    if (skippedNoDate > 0) {
      ctx.warnings.push(
        `sale_payments: ${skippedNoDate} filas descartadas por falta de created_at`,
      );
    }
    return count;
  }

  private async insertCreditNotes(ctx: ImportCtx, rows: ZipRow[]): Promise<number> {
    const repo = ctx.manager.getRepository(CreditNote);

    // 1. Filtrar filas sin `created_at` (bug #2).
    const dated: { row: ZipRow; createdAt: Date; updatedAt: Date | null }[] = [];
    let skippedNoDate = 0;
    for (const row of rows) {
      const { created_at, updated_at } = readZipDates(row);
      if (created_at === null) {
        skippedNoDate++;
        continue;
      }
      dated.push({ row, createdAt: created_at, updatedAt: updated_at });
    }

    // 2. Orden cronológico ASC para preservar el orden histórico de folios.
    dated.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());

    // 3. Prefijos del seed.
    const creditTs = ctx.tsByType.get(TicketSettingType.CREDIT_NOTE);
    const debitTs = ctx.tsByType.get(TicketSettingType.DEBIT_NOTE);
    const creditPrefix = creditTs?.prefix ?? null;
    const creditSuffix = creditTs?.suffix ?? null;
    const debitPrefix = debitTs?.prefix ?? null;
    const debitSuffix = debitTs?.suffix ?? null;

    let count = 0;
    let skipped = 0;
    for (const { row, createdAt, updatedAt } of dated) {
      // El backup nativo (placepos) usa `original_invoice_id`; el esquema cloud
      // usa `sale_invoice_id`. Sin este mapeo, las notas no resolvían su factura
      // y se descartaban todas (ajustes de anulación ausentes en el dashboard).
      const invoiceIdReal = ctx.remapper.getOptional(
        'sale_invoices',
        asNullableString(row.original_invoice_id ?? row.sale_invoice_id),
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

      // Renumeración: CREDIT consume el counter CREDIT_NOTE (prefijo NC),
      // DEBIT consume el counter DEBIT_NOTE (prefijo ND).
      let noteNumber: string;
      if (noteType === 'CREDIT') {
        const n = ++ctx.counters[TicketSettingType.CREDIT_NOTE];
        noteNumber = formatTicketNumber(creditPrefix, creditSuffix, n);
      } else {
        const n = ++ctx.counters[TicketSettingType.DEBIT_NOTE];
        noteNumber = formatTicketNumber(debitPrefix, debitSuffix, n);
      }

      const saved = await repo.save(
        repo.create({
          company_id: ctx.companyIdReal,
          sale_invoice_id: invoiceIdReal,
          customer_id: ctx.remapper.getOptional('customers', asNullableString(row.customer_id)),
          note_number: noteNumber,
          note_type: noteType as CreditNote['note_type'],
          operation_type: operationType as CreditNote['operation_type'],
          subtotal: Math.max(0, asNumber(row.subtotal ?? row.total)),
          tax_total: Math.max(0, asNumber(row.tax_total)),
          total: Math.max(0, asNumber(row.total)),
          reason: asNullableString(row.reason),
          created_by: asNullableString(row.created_by) ?? ctx.ownerFullName,
          created_by_id: this.remapUserId(ctx, row.created_by_id),
          is_deleted: asBoolean(row.is_deleted),
          created_at: createdAt,
          updated_at: updatedAt ?? createdAt,
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
    if (skippedNoDate > 0) {
      ctx.warnings.push(
        `credit_notes: ${skippedNoDate} filas descartadas por falta de created_at`,
      );
    }
    return count;
  }

  private async insertCreditNoteLines(ctx: ImportCtx, rows: ZipRow[]): Promise<number> {
    const repo = ctx.manager.getRepository(CreditNoteLine);
    let count = 0;
    let skipped = 0;
    let skippedNoDate = 0;
    for (const row of rows) {
      const { created_at } = readZipDates(row);
      if (created_at === null) {
        skippedNoDate++;
        continue;
      }
      const noteIdReal = ctx.remapper.getOptional(
        'credit_notes',
        asNullableString(row.credit_note_id),
      );
      // Offline usa `item_id`; cloud usa `product_id`.
      const productIdReal = ctx.remapper.getOptional(
        'products',
        asNullableString(row.item_id ?? row.product_id),
      );
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
          description:
            (asString(row.description) || asString(row.name)).trim() ||
            `Producto ${productIdReal}`,
          quantity,
          unit_price: Math.max(0, asNumber(row.unit_price ?? row.price)),
          unit_cost: Math.max(0, asNumber(row.unit_cost ?? row.cost)),
          subtotal: Math.max(0, asNumber(row.subtotal ?? row.total)),
          iva_percentage: asNumber(row.iva_percentage),
          iva_amount: Math.max(0, asNumber(row.iva_amount)),
          total: Math.max(0, asNumber(row.total)),
          created_at,
        }),
      );
      count++;
    }
    if (skipped > 0) {
      ctx.warnings.push(
        `credit_note_lines: ${skipped} líneas descartadas (FK faltante o qty inválida)`,
      );
    }
    if (skippedNoDate > 0) {
      ctx.warnings.push(
        `credit_note_lines: ${skippedNoDate} filas descartadas por falta de created_at`,
      );
    }
    return count;
  }

  // ---------------------------------------------------------------------
  // Compras
  // ---------------------------------------------------------------------

  private async insertPurchases(ctx: ImportCtx, rows: ZipRow[]): Promise<number> {
    const repo = ctx.manager.getRepository(Purchase);

    // 1. Filtrar filas sin `created_at` (bug #2).
    const dated: { row: ZipRow; createdAt: Date; updatedAt: Date | null }[] = [];
    let skippedNoDate = 0;
    for (const row of rows) {
      const { created_at, updated_at } = readZipDates(row);
      if (created_at === null) {
        skippedNoDate++;
        continue;
      }
      dated.push({ row, createdAt: created_at, updatedAt: updated_at });
    }

    // 2. Orden cronológico ASC para preservar el orden histórico de folios.
    dated.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());

    // 3. Prefijo del seed.
    const purchaseTs = ctx.tsByType.get(TicketSettingType.PURCHASE);
    const purchasePrefix = purchaseTs?.prefix ?? null;
    const purchaseSuffix = purchaseTs?.suffix ?? null;

    let count = 0;
    let skipped = 0;
    for (const { row, createdAt, updatedAt } of dated) {
      const supplierIdReal = ctx.remapper.getOptional(
        'suppliers',
        asNullableString(row.supplier_id),
      );
      if (supplierIdReal === null) {
        skipped++;
        continue;
      }

      const invoiceDate = asNullableDate(row.invoice_date);
      const purchaseNum = ++ctx.counters[TicketSettingType.PURCHASE];
      const purchaseNumber = formatTicketNumber(purchasePrefix, purchaseSuffix, purchaseNum);

      const saved = await repo.save(
        repo.create({
          company_id: ctx.companyIdReal,
          purchase_number: purchaseNumber,
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
          created_by_id: this.remapUserId(ctx, row.created_by_id),
          is_deleted: asBoolean(row.is_deleted),
          created_at: createdAt,
          updated_at: updatedAt ?? createdAt,
        }),
      );
      ctx.remapper.set('purchases', asString(row.id), saved.id);
      count++;
    }
    if (skipped > 0) {
      ctx.warnings.push(`purchases: ${skipped} compras descartadas por supplier inexistente`);
    }
    if (skippedNoDate > 0) {
      ctx.warnings.push(`purchases: ${skippedNoDate} filas descartadas por falta de created_at`);
    }
    return count;
  }

  private async insertPurchaseLines(ctx: ImportCtx, rows: ZipRow[]): Promise<number> {
    const repo = ctx.manager.getRepository(PurchaseLine);
    let count = 0;
    let skipped = 0;
    let skippedNoDate = 0;
    for (const row of rows) {
      const { created_at } = readZipDates(row);
      if (created_at === null) {
        skippedNoDate++;
        continue;
      }
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
          created_at,
        }),
      );
      count++;
    }
    if (skipped > 0) {
      ctx.warnings.push(
        `purchase_lines: ${skipped} líneas descartadas (FK faltante o qty inválida)`,
      );
    }
    if (skippedNoDate > 0) {
      ctx.warnings.push(
        `purchase_lines: ${skippedNoDate} filas descartadas por falta de created_at`,
      );
    }
    return count;
  }

  private async insertPurchaseCredits(ctx: ImportCtx, rows: ZipRow[]): Promise<number> {
    const repo = ctx.manager.getRepository(PurchaseCredit);

    // supplier_id por compra, tomado del propio ZIP de purchases: el dump de
    // purchase_credits no trae supplier_id, pero el modelo cloud lo exige
    // (FK NOT NULL). Mismo patrón que insertSaleCredits con el customer.
    const purchaseSupplier = new Map<string, string | null>();
    for (const p of ctx.zip.tables.get('purchases') ?? []) {
      purchaseSupplier.set(asString(p.id), asNullableString(p.supplier_id));
    }

    const seenPurchases = new Set<string>();
    let count = 0;
    let skipped = 0;
    let skippedNoDate = 0;
    let skippedNoSupplier = 0;
    for (const row of rows) {
      const { created_at, updated_at } = readZipDates(row);
      if (created_at === null) {
        skippedNoDate++;
        continue;
      }

      const localPurchaseId = asNullableString(row.purchase_id);
      const purchaseIdReal = ctx.remapper.getOptional('purchases', localPurchaseId);
      if (purchaseIdReal === null) {
        // La compra padre fue descartada (p.ej. supplier inexistente) → su
        // crédito no tiene a qué colgarse.
        skipped++;
        continue;
      }

      // UNIQUE(company_id, purchase_id): un crédito por compra.
      if (seenPurchases.has(purchaseIdReal)) {
        skipped++;
        continue;
      }

      const total = Math.max(0, asNumber(row.total_amount));
      if (total <= 0) {
        // CHECK chk_purchase_credits_total_positive.
        skipped++;
        continue;
      }

      const localSupplierId =
        localPurchaseId !== null ? (purchaseSupplier.get(localPurchaseId) ?? null) : null;
      const supplierIdReal = ctx.remapper.getOptional('suppliers', localSupplierId);
      if (supplierIdReal === null) {
        skippedNoSupplier++;
        continue;
      }

      // balance/status recomputados para respetar los CHECK de consistencia
      // contable (paid + balance = total; status coherente con paid/balance).
      const paid = Math.min(Math.max(0, asNumber(row.paid_amount)), total);
      const balance = Math.round((total - paid) * 100) / 100;
      const status =
        paid <= 0
          ? PurchaseCreditStatus.PENDING
          : balance > 0
            ? PurchaseCreditStatus.PARTIALLY_PAID
            : PurchaseCreditStatus.PAID;

      await repo.save(
        repo.create({
          company_id: ctx.companyIdReal,
          purchase_id: purchaseIdReal,
          supplier_id: supplierIdReal,
          total_amount: total,
          paid_amount: paid,
          balance,
          status,
          created_at,
          updated_at: updated_at ?? created_at,
        }),
      );
      seenPurchases.add(purchaseIdReal);
      count++;
    }
    if (skippedNoDate > 0) {
      ctx.warnings.push(
        `purchase_credits: ${skippedNoDate} filas descartadas por falta de created_at`,
      );
    }
    if (skipped > 0) {
      ctx.warnings.push(
        `purchase_credits: ${skipped} créditos descartados (FK faltante, duplicado o total inválido)`,
      );
    }
    if (skippedNoSupplier > 0) {
      ctx.warnings.push(
        `purchase_credits: ${skippedNoSupplier} créditos descartados por compra sin supplier`,
      );
    }
    return count;
  }

  private async insertPurchasePayments(ctx: ImportCtx, rows: ZipRow[]): Promise<number> {
    const repo = ctx.manager.getRepository(PurchasePayment);

    // 1. Filtrar filas sin `created_at` (bug #2).
    const dated: { row: ZipRow; createdAt: Date }[] = [];
    let skippedNoDate = 0;
    for (const row of rows) {
      const { created_at } = readZipDates(row);
      if (created_at === null) {
        skippedNoDate++;
        continue;
      }
      dated.push({ row, createdAt: created_at });
    }

    // 2. Orden cronológico ASC para preservar el orden histórico de folios.
    dated.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());

    // 3. Prefijo del seed.
    const ppTs = ctx.tsByType.get(TicketSettingType.PURCHASE_PAYMENT);
    const ppPrefix = ppTs?.prefix ?? null;
    const ppSuffix = ppTs?.suffix ?? null;

    let count = 0;
    let skipped = 0;
    for (const { row, createdAt } of dated) {
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

      const ppNum = ++ctx.counters[TicketSettingType.PURCHASE_PAYMENT];
      const paymentNumber = formatTicketNumber(ppPrefix, ppSuffix, ppNum);

      await repo.save(
        repo.create({
          company_id: ctx.companyIdReal,
          purchase_id: purchaseIdReal,
          payment_number: paymentNumber,
          payment_method: method as PurchasePayment['payment_method'],
          amount,
          bank_id: ctx.remapper.getOptional('banks', asNullableString(row.bank_id)),
          bank_name: asNullableString(row.bank_name),
          source_type: sourceType,
          source_id: sourceId,
          notes: asNullableString(row.notes),
          created_by: asNullableString(row.created_by) ?? ctx.ownerFullName,
          created_by_id: this.remapUserId(ctx, row.created_by_id),
          uuid: asNullableString(row.uuid),
          created_at: createdAt,
        }),
      );
      count++;
    }
    if (skipped > 0) {
      ctx.warnings.push(`purchase_payments: ${skipped} pagos descartados (FK o amount inválidos)`);
    }
    if (skippedNoDate > 0) {
      ctx.warnings.push(
        `purchase_payments: ${skippedNoDate} filas descartadas por falta de created_at`,
      );
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
    let skippedNoDate = 0;
    for (const row of rows) {
      const { created_at, updated_at } = readZipDates(row);
      if (created_at === null) {
        skippedNoDate++;
        continue;
      }
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
          created_by_id: this.remapUserId(ctx, row.created_by_id),
          created_at,
          updated_at: updated_at ?? created_at,
        }),
      );
      count++;
    }
    if (skipped > 0) {
      ctx.warnings.push(`expenses: ${skipped} gastos descartados por monto inválido`);
    }
    if (skippedNoDate > 0) {
      ctx.warnings.push(`expenses: ${skippedNoDate} filas descartadas por falta de created_at`);
    }
    return count;
  }

  // ---------------------------------------------------------------------
  // Gastos fijos
  // ---------------------------------------------------------------------

  /**
   * `fixed_expenses` — catálogo de gastos recurrentes. Master scoped por
   * `company_id`. `created_by` es NOT NULL en pos_api: si el dump no lo trae,
   * cae al nombre del owner.
   */
  private async insertFixedExpenses(ctx: ImportCtx, rows: ZipRow[]): Promise<number> {
    const repo = ctx.manager.getRepository(FixedExpense);
    const validUnits: readonly FixedExpensePeriodUnit[] = ['hour', 'day', 'week', 'month'];
    let count = 0;
    let skipped = 0;
    for (const row of rows) {
      const localId = asString(row.id);
      const amount = asNumber(row.amount);
      if (amount < 0) {
        skipped++;
        continue;
      }
      // period_quantity > 0 (CHECK). Si el dump trae basura, lo forzamos a 1.
      let periodQuantity = Math.trunc(asNumber(row.period_quantity));
      if (!Number.isFinite(periodQuantity) || periodQuantity <= 0) {
        periodQuantity = 1;
      }
      const rawUnit = asString(row.period_unit) as FixedExpensePeriodUnit;
      const periodUnit: FixedExpensePeriodUnit = validUnits.includes(rawUnit) ? rawUnit : 'month';

      const { created_at, updated_at } = readZipDates(row);
      const saved = await repo.save(
        repo.create({
          company_id: ctx.companyIdReal,
          name: asString(row.name).trim() || `Gasto fijo ${localId}`,
          description: asNullableString(row.description),
          amount,
          period_unit: periodUnit,
          period_quantity: periodQuantity,
          start_date: asDate(row.start_date),
          is_archived: asBoolean(row.is_archived),
          created_by: asNullableString(row.created_by) ?? ctx.ownerFullName,
          created_by_id: this.remapUserId(ctx, row.created_by_id),
          ...(created_at !== null ? { created_at, updated_at: updated_at ?? created_at } : {}),
        }),
      );
      ctx.remapper.set('fixed_expenses', localId, saved.id);
      count++;
    }
    if (skipped > 0) {
      ctx.warnings.push(`fixed_expenses: ${skipped} gastos fijos descartados por monto inválido`);
    }
    return count;
  }

  /**
   * `fixed_expense_periods` — cortes vencidos de un gasto fijo. Remapea
   * `fixed_expense_id` (requerido; descarta si no resuelve). `alert_id` se
   * fuerza a NULL (los `app_alerts` no se importan). `paid_by_id` se remapea a
   * `users` o queda NULL. `expense_id` queda NULL (los expenses materializados
   * no se cruzan en la migración). `company_id` stamped.
   */
  private async insertFixedExpensePeriods(ctx: ImportCtx, rows: ZipRow[]): Promise<number> {
    const repo = ctx.manager.getRepository(FixedExpensePeriod);
    const validStatuses: readonly FixedExpensePeriodStatus[] = ['PENDING', 'PAID'];
    let count = 0;
    let skipped = 0;
    // Defensa contra el UNIQUE (fixed_expense_id, period_number): si el dump
    // trae números duplicados por gasto, descartamos el segundo con warning en
    // vez de abortar toda la TX.
    const seenByExpense = new Map<string, Set<number>>();
    for (const row of rows) {
      const localId = asString(row.id);
      const fixedExpenseIdReal = ctx.remapper.getOptional(
        'fixed_expenses',
        asNullableString(row.fixed_expense_id),
      );
      if (fixedExpenseIdReal === null) {
        skipped++;
        continue;
      }
      const amount = asNumber(row.amount);
      if (amount < 0) {
        skipped++;
        continue;
      }
      // period_number > 0 (CHECK). Si viene inválido, forzamos a 1.
      let periodNumber = Math.trunc(asNumber(row.period_number));
      if (!Number.isFinite(periodNumber) || periodNumber <= 0) {
        periodNumber = 1;
      }
      let seen = seenByExpense.get(fixedExpenseIdReal);
      if (!seen) {
        seen = new Set<number>();
        seenByExpense.set(fixedExpenseIdReal, seen);
      }
      if (seen.has(periodNumber)) {
        skipped++;
        continue;
      }
      seen.add(periodNumber);

      const rawStatus = asString(row.status) as FixedExpensePeriodStatus;
      const status: FixedExpensePeriodStatus = validStatuses.includes(rawStatus)
        ? rawStatus
        : 'PENDING';
      // paid_by_id apunta a un user local. Solo el owner se importa a `users`,
      // así que cualquier otro id no resuelve y queda NULL.
      const paidById = ctx.remapper.getOptional('users', asNullableString(row.paid_by_id));

      const { created_at, updated_at } = readZipDates(row);
      const saved = await repo.save(
        repo.create({
          company_id: ctx.companyIdReal,
          fixed_expense_id: fixedExpenseIdReal,
          period_number: periodNumber,
          due_at: asDate(row.due_at),
          amount,
          status,
          // app_alerts no se importan → siempre NULL.
          alert_id: null,
          paid_at: status === 'PAID' ? asNullableDate(row.paid_at) : null,
          paid_by_id: paidById,
          // Expenses materializados no se cruzan en la migración.
          expense_id: null,
          ...(created_at !== null ? { created_at, updated_at: updated_at ?? created_at } : {}),
        }),
      );
      ctx.remapper.set('fixed_expense_periods', localId, saved.id);
      count++;
    }
    if (skipped > 0) {
      ctx.warnings.push(
        `fixed_expense_periods: ${skipped} cortes descartados (fixed_expense inexistente, monto inválido o period_number duplicado)`,
      );
    }
    return count;
  }

  // ---------------------------------------------------------------------
  // Domiciliarios (deliveries)
  // ---------------------------------------------------------------------

  /**
   * `delivery_companies` — domiciliarios/transportadoras. Master scoped por
   * `company_id`. `name` no-blank (CHECK). `phones` se persiste como jsonb
   * (array de strings); cualquier entrada no-string se descarta.
   */
  private async insertDeliveryCompanies(ctx: ImportCtx, rows: ZipRow[]): Promise<number> {
    const repo = ctx.manager.getRepository(DeliveryCompany);
    let count = 0;
    for (const row of rows) {
      const localId = asString(row.id);
      const name = asString(row.name).trim() || `Domiciliario ${localId}`;
      // `phones` puede venir como array nativo (Postgres jsonb) o como string
      // JSON (simple-json de SQLite en placepos). Normalizamos a string[].
      let phones: string[] = [];
      const rawPhones = row.phones;
      if (Array.isArray(rawPhones)) {
        phones = rawPhones.filter((p): p is string => typeof p === 'string');
      } else if (typeof rawPhones === 'string' && rawPhones.trim() !== '') {
        try {
          const parsed: unknown = JSON.parse(rawPhones);
          if (Array.isArray(parsed)) {
            phones = parsed.filter((p): p is string => typeof p === 'string');
          }
        } catch {
          phones = [];
        }
      }

      const { created_at, updated_at } = readZipDates(row);
      const saved = await repo.save(
        repo.create({
          company_id: ctx.companyIdReal,
          name,
          address: asNullableString(row.address),
          phones,
          is_archived: asBoolean(row.is_archived),
          created_by: asNullableString(row.created_by) ?? ctx.ownerFullName,
          created_by_id: this.remapUserId(ctx, row.created_by_id),
          ...(created_at !== null ? { created_at, updated_at: updated_at ?? created_at } : {}),
        }),
      );
      ctx.remapper.set('delivery_companies', localId, saved.id);
      count++;
    }
    return count;
  }

  /**
   * `deliveries` — domicilios registrados. Remapea `delivery_company_id`
   * (requerido; descarta si no resuelve), `invoice_id` (opcional → NULL si no
   * resuelve). `cash_register_log_id` se fuerza a NULL (los
   * `cash_register_logs` no se importan). `payment_method` se valida contra el
   * CHECK. `destination_address`/`recipient_name` son NOT NULL no-blank en
   * pos_api → fallback. `company_id` stamped.
   */
  private async insertDeliveries(ctx: ImportCtx, rows: ZipRow[]): Promise<number> {
    const repo = ctx.manager.getRepository(Delivery);
    const validMethods: readonly DeliveryPaymentMethod[] = ['on_delivery', 'cash_register'];
    let count = 0;
    let skipped = 0;
    for (const row of rows) {
      const localId = asString(row.id);
      const deliveryCompanyIdReal = ctx.remapper.getOptional(
        'delivery_companies',
        asNullableString(row.delivery_company_id),
      );
      if (deliveryCompanyIdReal === null) {
        skipped++;
        continue;
      }
      const amount = Math.max(0, asNumber(row.amount));
      const rawMethod = asString(row.payment_method) as DeliveryPaymentMethod;
      const paymentMethod: DeliveryPaymentMethod = validMethods.includes(rawMethod)
        ? rawMethod
        : 'on_delivery';
      // invoice_id opcional: NULL si no resuelve contra sale_invoices.
      const invoiceIdReal = ctx.remapper.getOptional(
        'sale_invoices',
        asNullableString(row.invoice_id),
      );

      const { created_at, updated_at } = readZipDates(row);
      const saved = await repo.save(
        repo.create({
          company_id: ctx.companyIdReal,
          invoice_id: invoiceIdReal,
          ticket_number: asNullableString(row.ticket_number),
          delivery_company_id: deliveryCompanyIdReal,
          delivery_company_name:
            asString(row.delivery_company_name).trim() || `Domiciliario ${deliveryCompanyIdReal}`,
          amount,
          payment_method: paymentMethod,
          notes: asNullableString(row.notes),
          destination_address: asString(row.destination_address).trim() || 'Sin dirección',
          recipient_name: asString(row.recipient_name).trim() || 'Sin destinatario',
          // cash_register_logs no se importan → siempre NULL.
          cash_register_log_id: null,
          is_archived: asBoolean(row.is_archived),
          created_by: asNullableString(row.created_by) ?? ctx.ownerFullName,
          created_by_id: this.remapUserId(ctx, row.created_by_id),
          ...(created_at !== null ? { created_at, updated_at: updated_at ?? created_at } : {}),
        }),
      );
      ctx.remapper.set('deliveries', localId, saved.id);
      count++;
    }
    if (skipped > 0) {
      ctx.warnings.push(
        `deliveries: ${skipped} domicilios descartados por delivery_company inexistente`,
      );
    }
    return count;
  }

  // ---------------------------------------------------------------------
  // Correcciones (rastro de devoluciones de notas)
  // ---------------------------------------------------------------------

  /**
   * `correction_sources` — rastro de auditoría 1:1 con una `CreditNote` que
   * generó retorno de dinero o ajuste de cartera.
   *
   * Mapeo backup→cloud:
   *   - `credit_note_id` se remapea contra `credit_notes`; requerido (FK NOT
   *     NULL + UNIQUE per-company). Si la nota padre fue descartada o el id no
   *     resuelve → skip + warning. UNIQUE: descartamos duplicados por nota.
   *   - `source_type` validado contra el CHECK cloud
   *     (`bank|wallet|cash_register|sale_credit`); cualquier otro valor → skip.
   *   - `source_id` es NOT NULL en cloud (offline lo emite sintético, p.ej. 0
   *     para `cash_register`). Lo remapeamos según el tipo:
   *       · bank          → `banks` (si no resuelve, no podemos satisfacer la
   *                         FK semántica → skip).
   *       · wallet        → wallet default sembrado.
   *       · cash_register → cash_register default sembrado.
   *       · sale_credit   → `sale_credits`. Como `sale_credits` se registra en
   *                         el remapper sólo por id local de crédito (no por
   *                         factura), si no resuelve degradamos a `cash_register`
   *                         del default para no perder el rastro.
   *   - `source_name` NOT NULL no-blank (CHECK) → fallback al tipo.
   *   - No se remapea su id (nadie depende de correction_sources).
   */
  private async insertCorrectionSources(ctx: ImportCtx, rows: ZipRow[]): Promise<number> {
    const repo = ctx.manager.getRepository(CorrectionSource);
    const validTypes: readonly CorrectionSource['source_type'][] = [
      'bank',
      'wallet',
      'cash_register',
      'sale_credit',
    ];
    const seenNotes = new Set<string>();
    let count = 0;
    let skipped = 0;
    let skippedNoDate = 0;
    for (const row of rows) {
      const { created_at } = readZipDates(row);
      if (created_at === null) {
        skippedNoDate++;
        continue;
      }
      const creditNoteIdReal = ctx.remapper.getOptional(
        'credit_notes',
        asNullableString(row.credit_note_id),
      );
      if (creditNoteIdReal === null) {
        skipped++;
        continue;
      }
      // UNIQUE(company_id, credit_note_id): una corrección por nota.
      if (seenNotes.has(creditNoteIdReal)) {
        skipped++;
        continue;
      }

      const rawType = asString(row.source_type) as CorrectionSource['source_type'];
      if (!validTypes.includes(rawType)) {
        skipped++;
        continue;
      }

      // source_id NOT NULL: remapeo según tipo. Para bank exigimos resolución
      // real; el resto cae a los defaults sembrados (caja/billetera) o degrada.
      let sourceType: CorrectionSource['source_type'] = rawType;
      let sourceId: string | null = null;
      if (rawType === 'bank') {
        sourceId = ctx.remapper.getOptional('banks', asNullableString(row.source_id));
        if (sourceId === null) {
          skipped++;
          continue;
        }
      } else if (rawType === 'wallet') {
        sourceId = ctx.defaultWalletId;
      } else if (rawType === 'sale_credit') {
        const scId = ctx.remapper.getOptional('sale_credits', asNullableString(row.source_id));
        if (scId !== null) {
          sourceId = scId;
        } else {
          // Sin crédito resoluble degradamos a caja para preservar el rastro.
          sourceType = 'cash_register';
          sourceId = ctx.defaultCashRegisterId;
        }
      } else {
        // cash_register.
        sourceId = ctx.defaultCashRegisterId;
      }

      const sourceName = asString(row.source_name).trim() || sourceType;

      await repo.save(
        repo.create({
          company_id: ctx.companyIdReal,
          credit_note_id: creditNoteIdReal,
          source_type: sourceType,
          source_id: sourceId,
          source_name: sourceName,
          created_by: asNullableString(row.created_by) ?? ctx.ownerFullName,
          created_by_id: this.remapUserId(ctx, row.created_by_id),
          created_at,
        }),
      );
      seenNotes.add(creditNoteIdReal);
      count++;
    }
    if (skipped > 0) {
      ctx.warnings.push(
        `correction_sources: ${skipped} correcciones descartadas (nota inexistente, duplicada, tipo o bank inválido)`,
      );
    }
    if (skippedNoDate > 0) {
      ctx.warnings.push(
        `correction_sources: ${skippedNoDate} filas descartadas por falta de created_at`,
      );
    }
    return count;
  }

  // ---------------------------------------------------------------------
  // Créditos / abonos a transportistas
  // ---------------------------------------------------------------------

  /**
   * `carrier_credits` — cuenta por pagar a un transportista, 1:1 con una
   * compra (flete). Se registra en el remapper porque `carrier_payments`
   * depende de su id.
   *
   * Mapeo backup→cloud:
   *   - `carrier_id` remapeado contra `carriers`; requerido (FK NOT NULL) →
   *     skip si no resuelve.
   *   - `purchase_id` remapeado contra `purchases`; requerido (FK NOT NULL) →
   *     skip si no resuelve. UNIQUE(company_id, purchase_id): un crédito por
   *     compra → descartamos duplicados.
   *   - `total/paid_amount/balance` recomputados (paid = min(paid, total);
   *     balance = total - paid) para respetar los CHECK contables
   *     (paid <= total; paid + balance ≈ total). total puede ser 0 (el CHECK
   *     cloud admite `total >= 0`, a diferencia de sale/purchase credits).
   *   - `status` offline (PENDING/PARTIAL/PAID) coincide con el enum cloud
   *     `carrier_credit_status` (PENDING/PARTIAL/PAID), pero lo recomputamos
   *     desde paid/balance para garantizar consistencia.
   */
  private async insertCarrierCredits(ctx: ImportCtx, rows: ZipRow[]): Promise<number> {
    const repo = ctx.manager.getRepository(CarrierCredit);
    const seenPurchases = new Set<string>();
    let count = 0;
    let skipped = 0;
    let skippedNoDate = 0;
    for (const row of rows) {
      const localId = asString(row.id);
      const { created_at, updated_at } = readZipDates(row);
      if (created_at === null) {
        skippedNoDate++;
        continue;
      }
      const carrierIdReal = ctx.remapper.getOptional('carriers', asNullableString(row.carrier_id));
      const purchaseIdReal = ctx.remapper.getOptional(
        'purchases',
        asNullableString(row.purchase_id),
      );
      if (carrierIdReal === null || purchaseIdReal === null) {
        skipped++;
        continue;
      }
      if (seenPurchases.has(purchaseIdReal)) {
        skipped++;
        continue;
      }

      const total = Math.max(0, asNumber(row.total));
      const paid = Math.min(Math.max(0, asNumber(row.paid_amount)), total);
      const balance = Math.round((total - paid) * 100) / 100;
      const status =
        paid <= 0
          ? CarrierCreditStatus.PENDING
          : balance > 0
            ? CarrierCreditStatus.PARTIAL
            : CarrierCreditStatus.PAID;

      const saved = await repo.save(
        repo.create({
          company_id: ctx.companyIdReal,
          carrier_id: carrierIdReal,
          purchase_id: purchaseIdReal,
          total,
          paid_amount: paid,
          balance,
          status,
          created_at,
          updated_at: updated_at ?? created_at,
        }),
      );
      ctx.remapper.set('carrier_credits', localId, saved.id);
      seenPurchases.add(purchaseIdReal);
      count++;
    }
    if (skipped > 0) {
      ctx.warnings.push(
        `carrier_credits: ${skipped} créditos descartados (carrier/compra inexistente o duplicado)`,
      );
    }
    if (skippedNoDate > 0) {
      ctx.warnings.push(
        `carrier_credits: ${skippedNoDate} filas descartadas por falta de created_at`,
      );
    }
    return count;
  }

  /**
   * `carrier_payments` — abono concreto a un `carrier_credit`. Va en el módulo
   * `inventory` DESPUÉS de `financial_movements` porque su
   * `financial_movement_id` es NOT NULL con FK RESTRICT.
   *
   * Mapeo backup→cloud:
   *   - `carrier_credit_id` remapeado; requerido → skip si no resuelve.
   *   - `financial_movement_id` remapeado contra `financial_movements`;
   *     requerido (FK NOT NULL RESTRICT). Si el FM padre no se migró → skip
   *     (no podemos inventar el respaldo contable).
   *   - `amount > 0` (CHECK) → skip si <= 0.
   *   - `payment_method` ∈ {CASH,BANK,WALLET}. El CHECK exige coherencia
   *     método↔cuenta: CASH ⇒ bank/wallet NULL; BANK ⇒ bank NOT NULL, wallet
   *     NULL; WALLET ⇒ wallet NOT NULL, bank NULL. Para BANK remapeamos el
   *     `bank_id`; si no resuelve degradamos el pago a CASH (preserva el monto
   *     y su FM). Para WALLET usamos el wallet default sembrado.
   *   - No se remapea su id (nadie depende de carrier_payments).
   */
  private async insertCarrierPayments(ctx: ImportCtx, rows: ZipRow[]): Promise<number> {
    const repo = ctx.manager.getRepository(CarrierPayment);
    let count = 0;
    let skipped = 0;
    let skippedNoDate = 0;
    for (const row of rows) {
      const { created_at } = readZipDates(row);
      if (created_at === null) {
        skippedNoDate++;
        continue;
      }
      const creditIdReal = ctx.remapper.getOptional(
        'carrier_credits',
        asNullableString(row.carrier_credit_id),
      );
      if (creditIdReal === null) {
        skipped++;
        continue;
      }
      const fmIdReal = ctx.remapper.getOptional(
        'financial_movements',
        asNullableString(row.financial_movement_id),
      );
      if (fmIdReal === null) {
        skipped++;
        continue;
      }
      const amount = asNumber(row.amount);
      if (amount <= 0) {
        skipped++;
        continue;
      }

      const rawMethod = asString(row.payment_method);
      let method: CarrierPaymentMethod;
      let bankId: string | null = null;
      let walletId: string | null = null;
      if (rawMethod === 'BANK') {
        const bankIdReal = ctx.remapper.getOptional('banks', asNullableString(row.bank_id));
        if (bankIdReal !== null) {
          method = CarrierPaymentMethod.BANK;
          bankId = bankIdReal;
        } else {
          // Sin banco resoluble degradamos a CASH (el CHECK exige bank/wallet
          // NULL para CASH) preservando monto y respaldo contable.
          method = CarrierPaymentMethod.CASH;
        }
      } else if (rawMethod === 'WALLET') {
        method = CarrierPaymentMethod.WALLET;
        walletId = ctx.defaultWalletId;
      } else {
        method = CarrierPaymentMethod.CASH;
      }

      await repo.save(
        repo.create({
          company_id: ctx.companyIdReal,
          carrier_credit_id: creditIdReal,
          amount,
          payment_method: method,
          bank_id: bankId,
          wallet_id: walletId,
          financial_movement_id: fmIdReal,
          description: asNullableString(row.description),
          created_by: asNullableString(row.created_by) ?? ctx.ownerFullName,
          created_by_id: this.remapUserId(ctx, row.created_by_id),
          created_at,
        }),
      );
      count++;
    }
    if (skipped > 0) {
      ctx.warnings.push(
        `carrier_payments: ${skipped} abonos descartados (crédito/FM inexistente o monto inválido)`,
      );
    }
    if (skippedNoDate > 0) {
      ctx.warnings.push(
        `carrier_payments: ${skippedNoDate} filas descartadas por falta de created_at`,
      );
    }
    return count;
  }

  // ---------------------------------------------------------------------
  // Historial de costo / precio de producto
  // ---------------------------------------------------------------------

  /**
   * `product_cost_history` — auditoría inmutable de cambios de costo. Se
   * registra en el remapper porque `product_price_history.cost_history_id`
   * depende de su id.
   *
   * Mapeo backup→cloud:
   *   - `product_id` remapeado; requerido (FK NOT NULL) → skip si no resuelve.
   *   - `purchase_id` remapeado contra `purchases`; opcional (FK SET NULL) →
   *     NULL si no resuelve.
   *   - `event_type` ∈ {RECEIVE,EDIT,ARCHIVE}; default RECEIVE si inválido.
   *   - `derived_from` ∈ {PURCHASE,PARENT}; default PURCHASE si inválido.
   *   - `cost_before/cost_after` numéricos (NUMERIC(15,4) cloud). `change_pct`
   *     offline es nullable; cloud lo guarda con default 0 → coalesce a 0.
   *   - `created_by` no viene en offline (sólo created_by_id) → owner.
   */
  private async insertProductCostHistory(ctx: ImportCtx, rows: ZipRow[]): Promise<number> {
    const repo = ctx.manager.getRepository(ProductCostHistory);
    const validEvents: readonly ProductCostHistoryEvent[] = [
      ProductCostHistoryEvent.RECEIVE,
      ProductCostHistoryEvent.EDIT,
      ProductCostHistoryEvent.ARCHIVE,
    ];
    const validSources: readonly ProductCostHistoryDerivedFrom[] = [
      ProductCostHistoryDerivedFrom.PURCHASE,
      ProductCostHistoryDerivedFrom.PARENT,
    ];
    let count = 0;
    let skipped = 0;
    let skippedNoDate = 0;
    for (const row of rows) {
      const localId = asString(row.id);
      const { created_at } = readZipDates(row);
      if (created_at === null) {
        skippedNoDate++;
        continue;
      }
      const productIdReal = ctx.remapper.getOptional('products', asNullableString(row.product_id));
      if (productIdReal === null) {
        skipped++;
        continue;
      }
      const rawEvent = asString(row.event_type) as ProductCostHistoryEvent;
      const eventType: ProductCostHistoryEvent = validEvents.includes(rawEvent)
        ? rawEvent
        : ProductCostHistoryEvent.RECEIVE;
      const rawDerived = asString(row.derived_from) as ProductCostHistoryDerivedFrom;
      const derivedFrom: ProductCostHistoryDerivedFrom = validSources.includes(rawDerived)
        ? rawDerived
        : ProductCostHistoryDerivedFrom.PURCHASE;

      const saved = await repo.save(
        repo.create({
          company_id: ctx.companyIdReal,
          product_id: productIdReal,
          purchase_id: ctx.remapper.getOptional('purchases', asNullableString(row.purchase_id)),
          event_type: eventType,
          derived_from: derivedFrom,
          cost_before: asNumber(row.cost_before),
          cost_after: asNumber(row.cost_after),
          change_pct: asNullableNumber(row.change_pct) ?? 0,
          created_by: asNullableString(row.created_by) ?? ctx.ownerFullName,
          created_by_id: this.remapUserId(ctx, row.created_by_id),
          created_at,
        }),
      );
      ctx.remapper.set('product_cost_history', localId, saved.id);
      count++;
    }
    if (skipped > 0) {
      ctx.warnings.push(
        `product_cost_history: ${skipped} entradas descartadas por product inexistente`,
      );
    }
    if (skippedNoDate > 0) {
      ctx.warnings.push(
        `product_cost_history: ${skippedNoDate} filas descartadas por falta de created_at`,
      );
    }
    return count;
  }

  /**
   * `product_price_history` — snapshot del profit/margin de un `product_prices`
   * antes/después de un cambio de costo.
   *
   * Mapeo backup→cloud:
   *   - `product_price_id` remapeado contra `product_prices`; requerido (FK NOT
   *     NULL) → skip si no resuelve. OJO: `product_prices` topa en 5 por
   *     producto en el import, así que precios excedentes no existen y sus
   *     snapshots se descartan legítimamente.
   *   - `product_id` remapeado; requerido (FK NOT NULL) → skip si no resuelve.
   *   - `cost_history_id` offline es NOT NULL, pero el cloud lo modela nullable
   *     (FK SET NULL). Lo remapeamos contra `product_cost_history`; si su row
   *     padre fue descartado, NO descartamos el snapshot: dejamos NULL.
   *   - `sale_price/profit_before/profit_after/margin_before/margin_after`
   *     numéricos (default 0 en cloud) → coalesce a 0.
   *   - `created_by`/`created_by_id` no vienen en offline → owner.
   */
  private async insertProductPriceHistory(ctx: ImportCtx, rows: ZipRow[]): Promise<number> {
    const repo = ctx.manager.getRepository(ProductPriceHistory);
    let count = 0;
    let skipped = 0;
    let skippedNoDate = 0;
    for (const row of rows) {
      const { created_at } = readZipDates(row);
      if (created_at === null) {
        skippedNoDate++;
        continue;
      }
      const productPriceIdReal = ctx.remapper.getOptional(
        'product_prices',
        asNullableString(row.product_price_id),
      );
      const productIdReal = ctx.remapper.getOptional('products', asNullableString(row.product_id));
      if (productPriceIdReal === null || productIdReal === null) {
        skipped++;
        continue;
      }
      // cost_history_id: nullable en cloud → NULL si el row padre fue descartado.
      const costHistoryIdReal = ctx.remapper.getOptional(
        'product_cost_history',
        asNullableString(row.cost_history_id),
      );

      await repo.save(
        repo.create({
          company_id: ctx.companyIdReal,
          product_price_id: productPriceIdReal,
          product_id: productIdReal,
          cost_history_id: costHistoryIdReal,
          sale_price: asNumber(row.sale_price),
          profit_before: asNumber(row.profit_before),
          profit_after: asNumber(row.profit_after),
          margin_before: asNumber(row.margin_before),
          margin_after: asNumber(row.margin_after),
          created_by: asNullableString(row.created_by) ?? ctx.ownerFullName,
          created_by_id: this.remapUserId(ctx, row.created_by_id),
          created_at,
        }),
      );
      count++;
    }
    if (skipped > 0) {
      ctx.warnings.push(
        `product_price_history: ${skipped} snapshots descartados (product_price/product inexistente)`,
      );
    }
    if (skippedNoDate > 0) {
      ctx.warnings.push(
        `product_price_history: ${skippedNoDate} filas descartadas por falta de created_at`,
      );
    }
    return count;
  }

  // ---------------------------------------------------------------------
  // Tesorería (libro de movimientos financieros)
  // ---------------------------------------------------------------------

  /**
   * `financial_movements` — libro de AUDITORÍA inmutable de tesorería. Se migra
   * en crudo (NO se regenera vía servicios) → no hay doble conteo. Se registra
   * en el remapper porque `carrier_payments.financial_movement_id` depende de
   * su id (FK NOT NULL RESTRICT).
   *
   * Referencias polimórficas source/destination (type+id):
   *   - `source_type`/`destination_type` ∈ {bank,wallet,cash_register,external}
   *     (CHECK). placepos puede emitir otros valores → si quedan ambos NULL el
   *     CHECK `has_endpoint` aborta, por eso validamos endpoint a endpoint.
   *   - El id de cada endpoint se remapea según su tipo:
   *       · bank          → `banks`. Si NO resuelve, anulamos ese endpoint
   *         (type+id a NULL) en vez de inventar un banco (los CHECK de
   *         consistencia exigen que bank/wallet lleven id non-null).
   *       · wallet        → wallet default sembrado.
   *       · cash_register → cash_register default sembrado. NOTA: el CHECK
   *         relajado (`relax-financial-movements-source-check`) permite
   *         cash_register/external CON id NULL, pero usamos el default para
   *         máxima fidelidad.
   *       · external      → sin id (el CHECK lo permite NULL).
   *   - Tras el remapeo, si AMBOS endpoints quedaron NULL el movimiento se
   *     descarta con warning (violaría `has_endpoint`); es el único caso de
   *     pérdida y sólo ocurre con dumps inconsistentes (todo bank irresoluble).
   *
   * Enum `concept`: el cloud no admite varios valores offline
   * (CASH_REGISTER_CLOSE, PURCHASE_PAYMENT, TAX_PAYMENT, PAYROLL, OTHER). Se
   * mapean al concepto cloud más cercano (ver `mapMovementConcept`) para no
   * perder el movimiento. `movement_type` ∈ {INCOME,EXPENSE,TRANSFER} es
   * idéntico en ambos lados.
   *
   * `amount > 0` (CHECK) → skip si <= 0. No tiene `updated_at`.
   */
  private async insertFinancialMovements(ctx: ImportCtx, rows: ZipRow[]): Promise<number> {
    const repo = ctx.manager.getRepository(FinancialMovement);
    const validTypes: readonly MovementType[] = [
      MovementType.INCOME,
      MovementType.EXPENSE,
      MovementType.TRANSFER,
    ];
    let count = 0;
    let skipped = 0;
    let skippedNoEndpoint = 0;
    let skippedNoDate = 0;
    for (const row of rows) {
      const localId = asString(row.id);
      const { created_at } = readZipDates(row);
      if (created_at === null) {
        skippedNoDate++;
        continue;
      }
      const amount = asNumber(row.amount);
      if (amount <= 0) {
        skipped++;
        continue;
      }
      const rawType = asString(row.movement_type) as MovementType;
      const movementType: MovementType = validTypes.includes(rawType)
        ? rawType
        : MovementType.EXPENSE;
      const concept = this.mapMovementConcept(asString(row.concept));

      const source = this.resolveMovementEndpoint(
        ctx,
        asNullableString(row.source_type),
        asNullableString(row.source_id),
      );
      const destination = this.resolveMovementEndpoint(
        ctx,
        asNullableString(row.destination_type),
        asNullableString(row.destination_id),
      );
      // CHECK chk_financial_movements_has_endpoint: al menos un endpoint.
      if (source.type === null && destination.type === null) {
        skippedNoEndpoint++;
        continue;
      }

      const saved = await repo.save(
        repo.create({
          company_id: ctx.companyIdReal,
          amount,
          movement_type: movementType,
          concept,
          description: asNullableString(row.description),
          source_type: source.type,
          source_id: source.id,
          destination_type: destination.type,
          destination_id: destination.id,
          reference_code: asNullableString(row.reference_code),
          created_by: asNullableString(row.created_by) ?? ctx.ownerFullName,
          created_by_id: this.remapUserId(ctx, row.created_by_id),
          created_at,
        }),
      );
      ctx.remapper.set('financial_movements', localId, saved.id);
      count++;
    }
    if (skipped > 0) {
      ctx.warnings.push(`financial_movements: ${skipped} movimientos descartados por monto inválido`);
    }
    if (skippedNoEndpoint > 0) {
      ctx.warnings.push(
        `financial_movements: ${skippedNoEndpoint} movimientos descartados por quedar sin endpoint resoluble`,
      );
    }
    if (skippedNoDate > 0) {
      ctx.warnings.push(
        `financial_movements: ${skippedNoDate} filas descartadas por falta de created_at`,
      );
    }
    return count;
  }

  /**
   * Mapea el `concept` offline al enum cloud `movement_concept`. Los valores
   * comunes pasan idénticos; los exclusivos de placepos
   * (CASH_REGISTER_CLOSE, PURCHASE_PAYMENT, TAX_PAYMENT, PAYROLL, OTHER) se
   * proyectan al cloud más cercano para no perder el movimiento.
   */
  private mapMovementConcept(raw: string): MovementConcept {
    switch (raw) {
      case 'SALE':
        return MovementConcept.SALE;
      case 'SALE_PAYMENT':
        return MovementConcept.SALE_PAYMENT;
      case 'PURCHASE':
        return MovementConcept.PURCHASE;
      case 'PURCHASE_PAYMENT':
        // El cloud no tiene PURCHASE_PAYMENT como concepto de tesorería: el
        // pago a compra es un egreso de caja/cartera → PURCHASE.
        return MovementConcept.PURCHASE;
      case 'EXPENSE':
        return MovementConcept.EXPENSE;
      case 'EXPENSE_PAYMENT':
        return MovementConcept.EXPENSE_PAYMENT;
      case 'TAX_PAYMENT':
      case 'PAYROLL':
        // Sin concepto dedicado en cloud → gasto.
        return MovementConcept.EXPENSE_PAYMENT;
      case 'TRANSFER':
        return MovementConcept.TRANSFER;
      case 'INITIAL_BALANCE':
        return MovementConcept.INITIAL_BALANCE;
      case 'REFUND':
        return MovementConcept.REFUND;
      case 'CARRIER_PAYMENT':
        return MovementConcept.CARRIER_PAYMENT;
      case 'ADJUSTMENT':
      case 'CASH_REGISTER_CLOSE':
      case 'OTHER':
      default:
        // Cierre de caja / sobrante / otros sin equivalente → ajuste.
        return MovementConcept.ADJUSTMENT;
    }
  }

  /**
   * Resuelve un endpoint (source o destination) de un `financial_movement`:
   * valida el tipo contra el CHECK y remapea el id según corresponda. Devuelve
   * `{ type:null, id:null }` cuando el endpoint no existe o no es resoluble
   * (p.ej. un bank que no se migró), respetando los CHECK de consistencia.
   */
  private resolveMovementEndpoint(
    ctx: ImportCtx,
    rawType: string | null,
    rawId: string | null,
  ): { type: AccountReference | null; id: string | null } {
    if (rawType === null || rawType === '') {
      return { type: null, id: null };
    }
    if (rawType === 'bank') {
      const bankIdReal = ctx.remapper.getOptional('banks', rawId);
      // bank exige id non-null (CHECK de consistencia): si no resuelve, anula
      // el endpoint completo en vez de inventar un banco.
      if (bankIdReal === null) {
        return { type: null, id: null };
      }
      return { type: 'bank', id: bankIdReal };
    }
    if (rawType === 'wallet') {
      return { type: 'wallet', id: ctx.defaultWalletId };
    }
    if (rawType === 'cash_register') {
      return { type: 'cash_register', id: ctx.defaultCashRegisterId };
    }
    if (rawType === 'external') {
      // external admite id NULL (CHECK relajado).
      return { type: 'external', id: null };
    }
    // Tipo desconocido → endpoint anulado.
    return { type: null, id: null };
  }

  // ---------------------------------------------------------------------
  // Movimientos de inventario
  // ---------------------------------------------------------------------

  /**
   * `inventory_movements` — log auditable de cambios a `Product.stock`.
   * Remapea `product_id` (requerido; descarta si no resuelve). `quantity > 0`
   * (CHECK), `direction IN ('IN','OUT')` (CHECK). `reference_type` de placepos
   * incluye valores que pos_api no admite (`adjustment`, `bulk_import`); se
   * normalizan a `manual`. `reference_id` se remapea según el tipo de
   * referencia (sale_invoice → sale_invoices, credit_note → credit_notes,
   * purchase → purchases); si no resuelve, el movimiento se conserva pero la
   * referencia se degrada a `manual`/NULL (es un log histórico, no se
   * descarta). `company_id` stamped. No tiene `updated_at`.
   */
  private async insertInventoryMovements(ctx: ImportCtx, rows: ZipRow[]): Promise<number> {
    const repo = ctx.manager.getRepository(InventoryMovement);
    const validReasons: readonly InventoryMovementReason[] = [
      'PURCHASE_RECEIVE',
      'PURCHASE_EDIT',
      'PURCHASE_ARCHIVE',
      'SALE',
      'SALE_VOID',
      'SALE_EDIT_CREDIT',
      'SALE_EDIT_DEBIT',
      'MANUAL_ADJUSTMENT',
      'BULK_IMPORT',
      'INITIAL_LOAD',
    ];
    let count = 0;
    let skipped = 0;
    let skippedNoDate = 0;
    for (const row of rows) {
      const { created_at } = readZipDates(row);
      if (created_at === null) {
        skippedNoDate++;
        continue;
      }
      const productIdReal = ctx.remapper.getOptional('products', asNullableString(row.product_id));
      if (productIdReal === null) {
        skipped++;
        continue;
      }
      const quantity = asNumber(row.quantity);
      if (quantity <= 0) {
        skipped++;
        continue;
      }
      const direction: InventoryMovementDirection = row.direction === 'OUT' ? 'OUT' : 'IN';
      const rawReason = asString(row.reason) as InventoryMovementReason;
      const reason: InventoryMovementReason = validReasons.includes(rawReason)
        ? rawReason
        : 'MANUAL_ADJUSTMENT';

      // reference_type/reference_id: pos_api admite sale_invoice|credit_note|
      // purchase|manual|null. placepos usa además adjustment|bulk_import →
      // normalizamos a manual. El reference_id se remapea contra la tabla
      // destino; si no resuelve, degradamos a manual/NULL (es un log).
      const rawRefType = asString(row.reference_type);
      const localRefId = asNullableString(row.reference_id);
      let referenceType: InventoryMovementReferenceType = null;
      let referenceId: string | null = null;
      if (rawRefType === 'sale_invoice') {
        const idReal = ctx.remapper.getOptional('sale_invoices', localRefId);
        if (idReal !== null) {
          referenceType = 'sale_invoice';
          referenceId = idReal;
        } else {
          referenceType = 'manual';
        }
      } else if (rawRefType === 'credit_note') {
        const idReal = ctx.remapper.getOptional('credit_notes', localRefId);
        if (idReal !== null) {
          referenceType = 'credit_note';
          referenceId = idReal;
        } else {
          referenceType = 'manual';
        }
      } else if (rawRefType === 'purchase') {
        const idReal = ctx.remapper.getOptional('purchases', localRefId);
        if (idReal !== null) {
          referenceType = 'purchase';
          referenceId = idReal;
        } else {
          referenceType = 'manual';
        }
      } else if (rawRefType !== '') {
        // adjustment | bulk_import | manual u otros → manual (sin id resoluble).
        referenceType = 'manual';
      }

      const saved = await repo.save(
        repo.create({
          company_id: ctx.companyIdReal,
          product_id: productIdReal,
          direction,
          quantity,
          reason,
          stock_before: asNumber(row.stock_before),
          stock_after: asNumber(row.stock_after),
          reference_type: referenceType,
          reference_id: referenceId,
          reference_code: asNullableString(row.reference_code),
          description: asNullableString(row.description),
          created_by: asNullableString(row.created_by) ?? ctx.ownerFullName,
          created_by_id: this.remapUserId(ctx, row.created_by_id),
          created_at,
        }),
      );
      ctx.remapper.set('inventory_movements', asString(row.id), saved.id);
      count++;
    }
    if (skipped > 0) {
      ctx.warnings.push(
        `inventory_movements: ${skipped} movimientos descartados (product inexistente o quantity inválida)`,
      );
    }
    if (skippedNoDate > 0) {
      ctx.warnings.push(
        `inventory_movements: ${skippedNoDate} filas descartadas por falta de created_at`,
      );
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
  /**
   * Contadores in-memory de folios por tipo. Arrancan en 0 (igual que el
   * `current_number` del seed) y se incrementan en cada insert. Al final de
   * la TX se persiste el valor de cada uno en `ticket_settings.current_number`.
   */
  counters: Record<TicketSettingType, number>;
  /**
   * Mapa de `TicketSetting` por tipo, cargado una sola vez justo después del
   * seed. Lo usan los inserts para obtener el `prefix`/`suffix` configurado.
   */
  tsByType: Map<TicketSettingType, TicketSetting>;
}
