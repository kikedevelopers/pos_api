import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';

import { Company } from '@/modules/companies/entities/company.entity';
import { CustomerCategory } from '@/modules/customer-categories/entities/customer-category.entity';
import { Customer, PersonType } from '@/modules/customers/entities/customer.entity';

/** Una fila cruda del CSV que el panel envía para importar. */
export interface ImportCustomerRow {
  person_type?: string | null;
  name?: string | null;
  doc_number?: string | null;
  phone?: string | null;
  email?: string | null;
  address?: string | null;
  category?: string | null;
}

export interface ImportTenantCustomersResult {
  /** Clientes insertados en el destino. */
  inserted: number;
  /** Omitidos por existir ya en el destino (o duplicados dentro del CSV). */
  skippedExisting: number;
  /** Omitidos por no tener nombre (fila inválida). */
  skippedInvalid: number;
  /** Categorías creadas en el destino al resolverlas por nombre. */
  categoriesCreated: number;
}

/** Snapshot de autoría de los clientes/categorías creados por esta importación. */
const IMPORT_CREATED_BY = 'Importado (kdevsadmin)';

/** Insertamos en lotes para no armar un INSERT gigante de una sola vez. */
const INSERT_CHUNK = 500;

/**
 * Importa una lista de clientes a un tenant (negocio o sucursal) desde el panel
 * superadmin. Pensado para mover/clonar la lista de clientes de un negocio a
 * otro con el mismo CSV que exporta `export-tenant-customers`.
 *
 * Reglas:
 *   - **Dedup idempotente.** Un cliente entrante se OMITE si ya existe en el
 *     destino (entre los activos). La llave de identidad es el `doc_number`
 *     cuando viene; si no, el nombre (normalizado). Recargar el mismo CSV no
 *     duplica. El dedup aplica también DENTRO del mismo archivo.
 *   - **Categoría por nombre.** La categoría viaja por nombre (los ids son
 *     locales a cada company). Se resuelve en el destino con find-or-create
 *     sobre las categorías ACTIVAS; si no existe, se crea.
 *   - **Solo identidad del cliente.** `balance`, `advance_balance`, `points`
 *     arrancan en 0 e `is_archived` en false. Nunca se copia estado de negocio.
 *   - **No destructivo.** Solo inserta; jamás borra ni modifica clientes del
 *     destino.
 *
 * Todo corre en una sola transacción: si algo falla, no queda nada a medias.
 */
@Injectable()
export class ImportTenantCustomersAction {
  private readonly logger = new Logger(ImportTenantCustomersAction.name);

  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  async execute(
    companyId: number,
    rows: ImportCustomerRow[],
  ): Promise<ImportTenantCustomersResult> {
    return this.dataSource.transaction(async (manager) => {
      const company = await manager
        .getRepository(Company)
        .findOne({ where: { id: String(companyId) } });
      if (!company) {
        throw new NotFoundException(`Company ${companyId} no existe.`);
      }

      const { existingDocs, existingNames } = await this.loadExistingKeys(manager, companyId);
      const categoryCache = await this.loadCategoryCache(manager, companyId);
      const categoriesBefore = categoryCache.size;

      // Llaves ya vistas en ESTE archivo para dedup intra-CSV.
      const seenDocs = new Set<string>();
      const seenNames = new Set<string>();

      const toInsert: Customer[] = [];
      let skippedExisting = 0;
      let skippedInvalid = 0;

      for (const raw of rows) {
        const name = (raw.name ?? '').trim();
        if (name.length === 0) {
          skippedInvalid += 1;
          continue;
        }

        const doc = (raw.doc_number ?? '').trim();
        const nameKey = name.toLowerCase();

        // Dedup: doc_number manda; si no hay, el nombre.
        if (doc.length > 0) {
          const docKey = doc.toLowerCase();
          if (existingDocs.has(docKey) || seenDocs.has(docKey)) {
            skippedExisting += 1;
            continue;
          }
          seenDocs.add(docKey);
        } else {
          if (existingNames.has(nameKey) || seenNames.has(nameKey)) {
            skippedExisting += 1;
            continue;
          }
          seenNames.add(nameKey);
        }

        const category_id = await this.resolveCategoryId(
          manager,
          companyId,
          raw.category,
          categoryCache,
        );

        toInsert.push(
          manager.create(Customer, {
            company_id: String(companyId),
            person_type:
              (raw.person_type ?? '').trim().toUpperCase() === PersonType.COMPANY
                ? PersonType.COMPANY
                : PersonType.INDIVIDUAL,
            name,
            email: (raw.email ?? '').trim() || null,
            phone: (raw.phone ?? '').trim() || null,
            doc_number: doc || null,
            address: (raw.address ?? '').trim() || null,
            category_id,
            balance: 0,
            advance_balance: 0,
            points: 0,
            is_archived: false,
            created_by: IMPORT_CREATED_BY,
            created_by_id: null,
          }),
        );
      }

      for (let i = 0; i < toInsert.length; i += INSERT_CHUNK) {
        await manager.save(Customer, toInsert.slice(i, i + INSERT_CHUNK));
      }

      const result: ImportTenantCustomersResult = {
        inserted: toInsert.length,
        skippedExisting,
        skippedInvalid,
        categoriesCreated: categoryCache.size - categoriesBefore,
      };

      this.logger.log({
        event: 'superadmin.tenant.customers.import',
        companyId,
        ...result,
      });

      return result;
    });
  }

  /**
   * Llaves de identidad de los clientes ACTIVOS ya presentes en el destino.
   * El dedup compara doc_number (normalizado a minúsculas) y nombre
   * (`lower(btrim(name))`, igual que el índice de la tabla).
   */
  private async loadExistingKeys(
    manager: EntityManager,
    companyId: number,
  ): Promise<{ existingDocs: Set<string>; existingNames: Set<string> }> {
    const rows = await manager.query<{ doc_key: string | null; name_key: string }[]>(
      `
      SELECT lower(btrim(doc_number)) AS doc_key,
             lower(btrim(name))       AS name_key
      FROM customers
      WHERE company_id = $1
        AND is_archived = false
      `,
      [companyId],
    );

    const existingDocs = new Set<string>();
    const existingNames = new Set<string>();
    for (const r of rows) {
      if (r.doc_key && r.doc_key.length > 0) existingDocs.add(r.doc_key);
      if (r.name_key && r.name_key.length > 0) existingNames.add(r.name_key);
    }
    return { existingDocs, existingNames };
  }

  /** Mapa `lower(btrim(name)) → id` de las categorías ACTIVAS del destino. */
  private async loadCategoryCache(
    manager: EntityManager,
    companyId: number,
  ): Promise<Map<string, string>> {
    const cats = await manager.find(CustomerCategory, {
      where: { company_id: String(companyId), is_archived: false },
    });
    const cache = new Map<string, string>();
    for (const c of cats) {
      cache.set(c.name.trim().toLowerCase(), c.id);
    }
    return cache;
  }

  /**
   * find-or-create de la categoría por nombre dentro del destino. Devuelve el
   * id (string) o `null` si la fila no trae categoría. Crea la categoría la
   * primera vez que aparece un nombre nuevo y la cachea.
   */
  private async resolveCategoryId(
    manager: EntityManager,
    companyId: number,
    rawName: string | null | undefined,
    cache: Map<string, string>,
  ): Promise<string | null> {
    const name = (rawName ?? '').trim();
    if (name.length === 0) return null;

    const key = name.toLowerCase();
    const cached = cache.get(key);
    if (cached) return cached;

    const created = await manager.save(
      manager.create(CustomerCategory, {
        company_id: String(companyId),
        name,
        is_archived: false,
        created_by: IMPORT_CREATED_BY,
        created_by_id: null,
      }),
    );
    cache.set(key, created.id);
    return created.id;
  }
}
