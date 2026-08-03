import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, QueryRunner } from 'typeorm';

import {
  MigrateCatalogBody,
  MigrateCatalogProductInput,
  MigrateCatalogResult,
  buildMigratePriceRow,
  canonicalPackagingName,
  dedupeByKey,
  isInvalidProduct,
  nameKey,
  packagingKey,
  sanitizeString,
  validPrices,
} from '../internal/migrate-catalog.helpers';

/** SQLSTATE `unique_violation`. */
const PG_UNIQUE_VIOLATION = '23505';

interface OwnerInfo {
  id: number | null;
  name: string;
}

/**
 * Migra un catálogo (productos + presentaciones + categorías + empaques +
 * clientes) mapeado desde Mongo hacia una company destino de pos_api,
 * preservando la jerarquía base↔presentación e idempotente por nombre
 * (`lower(btrim(name))`).
 *
 * Todo ocurre en UNA transacción. Cada INSERT que puede colisionar con un
 * índice único parcial (`sku_code`/`bar_code`/`name` de `products`) va bajo un
 * SAVEPOINT: una colisión 23505 descarta ESA fila (se cuenta como saltada) sin
 * abortar la transacción completa — espejo del patrón de `ImportTenantAction`.
 *
 * Dedupe (AUTORIDAD pos_api):
 *   - contra productos/clientes ACTIVOS existentes → `skippedExisting`.
 *   - contra los ya insertados en este batch → `skippedDuplicate`.
 *   El base existente por nombre SE REUTILIZA como parent para colgar
 *   presentaciones nuevas.
 *
 * Filtros de exclusión defensivos (kdevs ya los aplicó): nombre vacío/basura o
 * sin precio válido → `skippedInvalid`. Presentación cuyo base fue excluido y
 * no existe en destino → `skippedOrphan`.
 */
@Injectable()
export class MigrateCatalogAction {
  private readonly logger = new Logger(MigrateCatalogAction.name);

  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  async execute(companyId: number, body: MigrateCatalogBody): Promise<MigrateCatalogResult> {
    const products = Array.isArray(body?.products) ? body.products : [];
    const customers = Array.isArray(body?.customers) ? body.customers : [];

    // La company destino debe existir.
    const target = await this.dataSource.query<Array<{ id: number }>>(
      `SELECT id FROM companies WHERE id = $1`,
      [companyId],
    );
    if (!target.length) {
      throw new BadRequestException(`La company destino ${companyId} no existe.`);
    }

    const owner = await this.resolveOwner(companyId);

    const result: MigrateCatalogResult = {
      business: body?.meta
        ? { name: body.meta.businessName, mongoId: body.meta.mongoBusinessId }
        : undefined,
      products: {
        inserted: 0,
        skippedExisting: 0,
        skippedDuplicate: 0,
        skippedOrphan: 0,
        skippedInvalid: 0,
      },
      presentations: { inserted: 0, skipped: 0 },
      categories: { created: 0, reused: 0 },
      packagings: { created: 0, reused: 0 },
      customers: { inserted: 0, skippedExisting: 0, skippedDuplicate: 0 },
      prices: { inserted: 0 },
    };

    // 1) Filtro de exclusión (defensivo). Los inválidos NO participan en nada.
    const valid: MigrateCatalogProductInput[] = [];
    for (const p of products) {
      if (isInvalidProduct(p)) {
        result.products.skippedInvalid += 1;
      } else {
        valid.push(p);
      }
    }
    const bases = valid.filter((p) => !p.parentSrcId);
    const presentations = valid.filter((p) => !!p.parentSrcId);

    const runner = this.dataSource.createQueryRunner();
    await runner.connect();
    await runner.startTransaction();
    try {
      // 2) Precarga de estado ACTIVO del destino.
      const [existingProducts, existingCustomers, catByKey, pkgByKey] = await Promise.all([
        this.loadNameIdMap(runner, 'products', companyId),
        this.loadCustomerNames(runner, companyId),
        this.loadNameIdMap(runner, 'categories', companyId),
        this.loadPackagings(runner, companyId),
      ]);

      // 3) CATEGORÍAS (find-or-create). Distinct de todos los productos válidos.
      const catIdByKey = new Map<string, string>(catByKey);
      await this.processCategories(runner, companyId, valid, catIdByKey, result);

      // 4) EMPAQUES (find-or-create con nombre canónico). Distinct de las
      //    presentaciones por (nombre, value).
      const pkgIdByNameKey = new Map<string, string>();
      const pkgNameToValue = new Map<string, number>();
      for (const [key, { id, value }] of pkgByKey) {
        pkgIdByNameKey.set(key, id);
        pkgNameToValue.set(key, value);
      }
      const pkgIdByPkgKey = await this.processPackagings(
        runner,
        companyId,
        presentations,
        pkgIdByNameKey,
        pkgNameToValue,
        owner,
        result,
      );

      // 5) PRODUCTOS: primero BASES, luego PRESENTACIONES.
      //    `nameToId` arranca con los existentes; `preExistingKeys` distingue
      //    skippedExisting (ya en BD) de skippedDuplicate (repetido en batch).
      const nameToId = new Map<string, string>(existingProducts);
      const preExistingKeys = new Set<string>(existingProducts.keys());
      const srcToProductId = new Map<string, string>();

      for (const base of bases) {
        const key = nameKey(base.name);
        const known = nameToId.get(key);
        if (known !== undefined) {
          if (preExistingKeys.has(key)) {
            result.products.skippedExisting += 1;
          } else {
            result.products.skippedDuplicate += 1;
          }
          // Reutiliza como parent para colgar presentaciones nuevas.
          srcToProductId.set(base.srcId, known);
          continue;
        }
        const newId = await this.insertProduct(runner, companyId, base, {
          parentId: null,
          packagingId: null,
          categoryId: this.categoryIdOf(base, catIdByKey),
          stock: base.stock,
          owner,
          result,
        });
        if (newId === null) {
          // Colisión UNIQUE (sku/barcode/name race) → saltada.
          result.products.skippedExisting += 1;
          continue;
        }
        result.products.inserted += 1;
        nameToId.set(key, newId);
        srcToProductId.set(base.srcId, newId);
      }

      for (const pres of presentations) {
        const parentId = pres.parentSrcId ? srcToProductId.get(pres.parentSrcId) : undefined;
        if (!parentId) {
          result.products.skippedOrphan += 1;
          result.presentations.skipped += 1;
          continue;
        }
        const key = nameKey(pres.name);
        const known = nameToId.get(key);
        if (known !== undefined) {
          if (preExistingKeys.has(key)) {
            result.products.skippedExisting += 1;
          } else {
            result.products.skippedDuplicate += 1;
          }
          result.presentations.skipped += 1;
          continue;
        }
        const packagingId = pres.packaging
          ? (pkgIdByPkgKey.get(packagingKey(pres.packaging.name, pres.packaging.value)) ?? null)
          : null;
        const newId = await this.insertProduct(runner, companyId, pres, {
          parentId,
          packagingId,
          categoryId: this.categoryIdOf(pres, catIdByKey),
          stock: 0, // presentación: stock siempre 0 (vive del base).
          owner,
          result,
        });
        if (newId === null) {
          result.products.skippedExisting += 1;
          result.presentations.skipped += 1;
          continue;
        }
        result.products.inserted += 1;
        result.presentations.inserted += 1;
        nameToId.set(key, newId);
        srcToProductId.set(pres.srcId, newId);
      }

      // 6) CLIENTES: dedupe por nombre.
      const custKeys = new Set<string>(existingCustomers);
      const preExistingCustKeys = new Set<string>(existingCustomers);
      for (const c of customers) {
        const name = (c?.name ?? '').trim();
        if (name.length === 0) {
          continue; // defensivo: kdevs ya filtró nombres vacíos.
        }
        const key = nameKey(name);
        if (custKeys.has(key)) {
          if (preExistingCustKeys.has(key)) {
            result.customers.skippedExisting += 1;
          } else {
            result.customers.skippedDuplicate += 1;
          }
          continue;
        }
        const inserted = await this.insertCustomer(runner, companyId, c, name, owner);
        if (!inserted) {
          result.customers.skippedExisting += 1;
          continue;
        }
        result.customers.inserted += 1;
        custKeys.add(key);
      }

      await runner.commitTransaction();
    } catch (err) {
      await runner.rollbackTransaction();
      throw err;
    } finally {
      await runner.release();
    }

    this.logger.log({
      event: 'superadmin.tenant.migrate_catalog',
      companyId,
      mongoBusinessId: body?.meta?.mongoBusinessId ?? null,
      products: result.products,
      customers: result.customers,
      categories: result.categories,
      packagings: result.packagings,
      prices: result.prices,
    });

    return result;
  }

  // --------------------------------------------------------------------------
  // Precarga
  // --------------------------------------------------------------------------

  /** `Map<nameKey, id>` de filas ACTIVAS (is_archived=false) de `products`/`categories`. */
  private async loadNameIdMap(
    runner: QueryRunner,
    table: 'products' | 'categories',
    companyId: number,
  ): Promise<Map<string, string>> {
    const rows = (await runner.query(
      `SELECT id, name FROM ${table} WHERE company_id = $1 AND is_archived = false`,
      [companyId],
    )) as Array<{ id: string; name: string }>;
    const map = new Map<string, string>();
    for (const row of rows) {
      const key = nameKey(row.name);
      if (!map.has(key)) {
        map.set(key, String(row.id));
      }
    }
    return map;
  }

  /** Set de `nameKey` de clientes ACTIVOS. */
  private async loadCustomerNames(runner: QueryRunner, companyId: number): Promise<Set<string>> {
    const rows = (await runner.query(
      `SELECT name FROM customers WHERE company_id = $1 AND is_archived = false`,
      [companyId],
    )) as Array<{ name: string }>;
    return new Set(rows.map((r) => nameKey(r.name)));
  }

  /** `Map<nameKey, {id, value}>` de empaques ACTIVOS. */
  private async loadPackagings(
    runner: QueryRunner,
    companyId: number,
  ): Promise<Map<string, { id: string; value: number }>> {
    const rows = (await runner.query(
      `SELECT id, name, value FROM packagings WHERE company_id = $1 AND is_archived = false`,
      [companyId],
    )) as Array<{ id: string; name: string; value: string }>;
    const map = new Map<string, { id: string; value: number }>();
    for (const row of rows) {
      const key = nameKey(row.name);
      if (!map.has(key)) {
        map.set(key, { id: String(row.id), value: Number(row.value) });
      }
    }
    return map;
  }

  // --------------------------------------------------------------------------
  // Categorías / Empaques
  // --------------------------------------------------------------------------

  private async processCategories(
    runner: QueryRunner,
    companyId: number,
    valid: MigrateCatalogProductInput[],
    catIdByKey: Map<string, string>,
    result: MigrateCatalogResult,
  ): Promise<void> {
    const distinct = new Map<string, string>(); // nameKey → nombre representativo (trim).
    for (const p of valid) {
      const raw = sanitizeString(p.category ?? null);
      if (!raw) {
        continue;
      }
      const key = nameKey(raw);
      if (!distinct.has(key)) {
        distinct.set(key, raw);
      }
    }
    for (const [key, name] of distinct) {
      if (catIdByKey.has(key)) {
        result.categories.reused += 1;
        continue;
      }
      const id = await this.findOrCreateByName(
        runner,
        'categories',
        companyId,
        name,
        `INSERT INTO categories (company_id, name, is_archived) VALUES ($1, $2, false) RETURNING id`,
        [companyId, name],
      );
      if (id.created) {
        result.categories.created += 1;
      } else {
        result.categories.reused += 1;
      }
      catIdByKey.set(key, id.id);
    }
  }

  /**
   * Procesa los empaques distintos de las presentaciones (por nombre+value) y
   * devuelve `Map<packagingKey, packagingId>` para resolver el `packaging_id`
   * de cada presentación.
   */
  private async processPackagings(
    runner: QueryRunner,
    companyId: number,
    presentations: MigrateCatalogProductInput[],
    pkgIdByNameKey: Map<string, string>,
    pkgNameToValue: Map<string, number>,
    owner: OwnerInfo,
    result: MigrateCatalogResult,
  ): Promise<Map<string, string>> {
    const pkgKeyToId = new Map<string, string>();

    const withPkg = presentations.filter(
      (p): p is MigrateCatalogProductInput & { packaging: { name: string; value: number } } =>
        !!p.packaging,
    );
    const { unique } = dedupeByKey(withPkg, (p) =>
      packagingKey(p.packaging.name, p.packaging.value),
    );

    for (const p of unique) {
      const { name: rawName, value } = p.packaging;
      const canonical = canonicalPackagingName(rawName, value, pkgNameToValue);
      const cKey = nameKey(canonical);
      const pKey = packagingKey(rawName, value);

      const existingId = pkgIdByNameKey.get(cKey);
      if (existingId !== undefined) {
        result.packagings.reused += 1;
        pkgKeyToId.set(pKey, existingId);
        continue;
      }
      const id = await this.findOrCreateByName(
        runner,
        'packagings',
        companyId,
        canonical,
        `INSERT INTO packagings (company_id, name, value, is_archived, is_auto, created_by, created_by_id)
         VALUES ($1, $2, $3, false, false, $4, $5) RETURNING id`,
        [companyId, canonical, value, owner.name, owner.id],
      );
      if (id.created) {
        result.packagings.created += 1;
      } else {
        result.packagings.reused += 1;
      }
      pkgIdByNameKey.set(cKey, id.id);
      pkgNameToValue.set(cKey, value);
      pkgKeyToId.set(pKey, id.id);
    }

    return pkgKeyToId;
  }

  /**
   * find-or-create por `lower(btrim(name))` bajo SAVEPOINT: intenta insertar;
   * si choca con el índice único parcial (23505), re-selecciona el id existente
   * (resolución de carrera / colisión de nombre canónico ya presente).
   */
  private async findOrCreateByName(
    runner: QueryRunner,
    table: 'categories' | 'packagings',
    companyId: number,
    name: string,
    insertSql: string,
    insertParams: unknown[],
  ): Promise<{ id: string; created: boolean }> {
    await runner.query('SAVEPOINT foc_sp');
    try {
      const inserted = (await runner.query(insertSql, insertParams)) as Array<{ id: string }>;
      await runner.query('RELEASE SAVEPOINT foc_sp');
      return { id: String(inserted[0].id), created: true };
    } catch (err) {
      await runner.query('ROLLBACK TO SAVEPOINT foc_sp');
      if (!this.isUniqueViolation(err)) {
        throw err;
      }
      const existing = (await runner.query(
        `SELECT id FROM ${table}
          WHERE company_id = $1 AND lower(btrim(name)) = lower(btrim($2)) AND is_archived = false
          ORDER BY id LIMIT 1`,
        [companyId, name],
      )) as Array<{ id: string }>;
      if (!existing.length) {
        throw err;
      }
      return { id: String(existing[0].id), created: false };
    }
  }

  // --------------------------------------------------------------------------
  // Productos / Precios / Clientes
  // --------------------------------------------------------------------------

  private categoryIdOf(
    product: MigrateCatalogProductInput,
    catIdByKey: Map<string, string>,
  ): string | null {
    const raw = sanitizeString(product.category ?? null);
    if (!raw) {
      return null;
    }
    return catIdByKey.get(nameKey(raw)) ?? null;
  }

  /**
   * Inserta un producto + sus precios bajo un SAVEPOINT. Devuelve el nuevo id, o
   * `null` si chocó con un índice único (23505) → la fila se descarta y la
   * transacción continúa. Cualquier otro error aborta (bug real).
   */
  private async insertProduct(
    runner: QueryRunner,
    companyId: number,
    product: MigrateCatalogProductInput,
    opts: {
      parentId: string | null;
      packagingId: string | null;
      categoryId: string | null;
      stock: number;
      owner: OwnerInfo;
      result: MigrateCatalogResult;
    },
  ): Promise<string | null> {
    const name = product.name.trim();
    const sku = sanitizeString(product.sku_code ?? null);
    const barcode = sanitizeString(product.bar_code ?? null);

    await runner.query('SAVEPOINT prod_sp');
    try {
      const inserted = (await runner.query(
        `INSERT INTO products
           (company_id, name, product_type, parent_id, sku_code, bar_code,
            packaging_id, category_id, cost, stock, show_in_pos, is_purchasable,
            is_archived, created_by, created_by_id)
         VALUES ($1, $2, 'SIMPLE', $3, $4, $5, $6, $7, $8, $9, true, false, false, $10, $11)
         RETURNING id`,
        [
          companyId,
          name,
          opts.parentId,
          sku,
          barcode,
          opts.packagingId,
          opts.categoryId,
          product.cost,
          opts.stock,
          opts.owner.name,
          opts.owner.id,
        ],
      )) as Array<{ id: string }>;
      const productId = String(inserted[0].id);

      const rows = validPrices(product.prices).map((p) => buildMigratePriceRow(p, product.cost));
      for (const row of rows) {
        await runner.query(
          `INSERT INTO product_prices
             (company_id, product_id, name, sale_price, profit, margin, iva_percentage,
              created_by, created_by_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [
            companyId,
            productId,
            row.name,
            row.sale_price,
            row.profit,
            row.margin,
            row.iva_percentage,
            opts.owner.name,
            opts.owner.id,
          ],
        );
      }

      await runner.query('RELEASE SAVEPOINT prod_sp');
      opts.result.prices.inserted += rows.length;
      return productId;
    } catch (err) {
      await runner.query('ROLLBACK TO SAVEPOINT prod_sp');
      if (this.isUniqueViolation(err)) {
        this.logger.warn({
          event: 'superadmin.tenant.migrate_catalog.product_skipped',
          srcId: product.srcId,
          name,
          reason: (err as Error).message,
        });
        return null;
      }
      throw err;
    }
  }

  private async insertCustomer(
    runner: QueryRunner,
    companyId: number,
    customer: {
      email?: string | null;
      phone?: string | null;
      doc_number?: string | null;
      address?: string | null;
    },
    name: string,
    owner: OwnerInfo,
  ): Promise<boolean> {
    await runner.query('SAVEPOINT cust_sp');
    try {
      await runner.query(
        `INSERT INTO customers
           (company_id, person_type, name, email, phone, doc_number, address,
            balance, advance_balance, points, is_archived, created_by, created_by_id)
         VALUES ($1, 'INDIVIDUAL', $2, $3, $4, $5, $6, 0, 0, 0, false, $7, $8)`,
        [
          companyId,
          name,
          sanitizeString(customer.email ?? null),
          sanitizeString(customer.phone ?? null),
          sanitizeString(customer.doc_number ?? null),
          sanitizeString(customer.address ?? null),
          owner.name,
          owner.id,
        ],
      );
      await runner.query('RELEASE SAVEPOINT cust_sp');
      return true;
    } catch (err) {
      await runner.query('ROLLBACK TO SAVEPOINT cust_sp');
      if (this.isUniqueViolation(err)) {
        return false;
      }
      throw err;
    }
  }

  // --------------------------------------------------------------------------

  private isUniqueViolation(err: unknown): boolean {
    return (
      typeof err === 'object' &&
      err !== null &&
      (err as { code?: string }).code === PG_UNIQUE_VIOLATION
    );
  }

  /**
   * Owner (`type='owner'`) del destino para `created_by`/`created_by_id`. Si no
   * hay owner, cae a `('Migración Mongo', null)`.
   *
   * Una SUCURSAL no tiene fila propia en `users` —su owner es el del negocio
   * principal, alcanzable por `company_members`—, así que la búsqueda directa
   * no encuentra nada. Sin el fallback, migrar el catálogo a una sucursal dejaba
   * todos los productos y clientes sin autor, atribuidos a "Migración Mongo".
   */
  private async resolveOwner(companyId: number): Promise<OwnerInfo> {
    // `priority` fija el ganador: el owner DIRECTO manda sobre el heredado por
    // membresía. Un LIMIT suelto sobre el UNION ALL no lo garantiza — el orden
    // entre ramas no es parte del contrato de SQL.
    const rows = await this.dataSource.query<Array<{ id: number; name: string | null }>>(
      `SELECT id, name FROM (
         SELECT u.id, NULLIF(TRIM(CONCAT_WS(' ', u.name, u.lastname)), '') AS name, 1 AS priority
           FROM users u
          WHERE u.company_id = $1 AND u.type = 'owner'
          UNION ALL
         SELECT u.id, NULLIF(TRIM(CONCAT_WS(' ', u.name, u.lastname)), '') AS name, 2 AS priority
           FROM company_members cm
           JOIN users u ON u.id = cm.user_id
          WHERE cm.company_id = $1 AND cm.role = 'owner'
       ) candidates
       ORDER BY priority ASC, id ASC
       LIMIT 1`,
      [companyId],
    );
    const owner = rows[0];
    if (!owner) {
      return { id: null, name: 'Migración Mongo' };
    }
    return { id: owner.id, name: owner.name ?? 'Migración Mongo' };
  }
}
