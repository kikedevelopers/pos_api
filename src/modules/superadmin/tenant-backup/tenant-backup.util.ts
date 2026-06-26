import { createHash } from 'node:crypto';

/**
 * Utilidades del respaldo COMPLETO por tenant (export/import) del panel
 * superadmin. El diseño es 100% DINÁMICO: el universo de tablas y el grafo de
 * relaciones se descubren por introspección del catálogo de Postgres en cada
 * ejecución. Crear una tabla nueva (con su `company_id` → companies) o cambiar
 * columnas/llaves NO requiere tocar este código: el respaldo se ajusta solo.
 */

export const TENANT_BACKUP_FORMAT = 'kdevs-tenant-backup';
export const TENANT_BACKUP_VERSION = 1;

/** Una fila cruda de una tabla (columna → valor), tal cual `SELECT *`. */
export type BackupRow = Record<string, unknown>;

export interface TenantBackup {
  format: typeof TENANT_BACKUP_FORMAT;
  version: number;
  meta: {
    companyId: number;
    companyName: string;
    generatedAt: string;
    tableCount: number;
    rowCount: number;
    /** sha256 hex de la representación canónica de `tables` (anti-alteración). */
    hash: string;
  };
  /** tabla → filas. Las columnas son implícitas (claves de cada fila). */
  tables: Record<string, BackupRow[]>;
}

export interface ImportTableResult {
  table: string;
  inserted: number;
  ignored: number;
  skipped: number;
}

export interface ImportResult {
  companyId: number;
  inserted: number;
  ignored: number;
  skipped: number;
  perTable: ImportTableResult[];
}

/** Función de consulta mínima (DataSource/QueryRunner/manager `.query`). */
export type QueryFn = <T = unknown>(sql: string, params?: unknown[]) => Promise<T[]>;

// --------------------------------------------------------------------------
// Identificadores
// --------------------------------------------------------------------------

/**
 * Cita un identificador SQL. Las tablas/columnas provienen SIEMPRE del catálogo
 * de Postgres (nunca de input del usuario), pero las citamos igual por higiene
 * y para soportar nombres con mayúsculas/palabras reservadas.
 */
export function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

// --------------------------------------------------------------------------
// Hash canónico (determinista, independiente del orden de claves)
// --------------------------------------------------------------------------

/**
 * Normaliza un valor a una forma estable y comparable byte-a-byte tras un
 * round-trip por JSON: ordena claves de objetos, convierte Date→ISO, descarta
 * `undefined`. Así el hash calculado en el EXPORT (sobre objetos con Date,
 * numéricos como string, jsonb como objeto) coincide con el recalculado en el
 * IMPORT sobre los mismos datos ya serializados/deserializados por la red.
 */
export function canonicalize(value: unknown): unknown {
  if (value === null || value === undefined) {
    return null;
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v === undefined) {
        continue;
      }
      out[key] = canonicalize(v);
    }
    return out;
  }
  return value;
}

/** sha256 hex de la representación canónica del mapa de tablas. */
export function computeTablesHash(tables: Record<string, BackupRow[]>): string {
  const canonical = JSON.stringify(canonicalize(tables));
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

// --------------------------------------------------------------------------
// Serialización de valores para INSERT
// --------------------------------------------------------------------------

/**
 * Prepara un valor (venido del JSON del respaldo) para pasarlo como parámetro a
 * un INSERT. Solo las columnas `json`/`jsonb` necesitan re-stringificarse (el
 * driver `pg` convertiría un array JS en un literal de array de Postgres, no en
 * JSON). El resto (ISO strings para timestamptz, numéricos como string,
 * booleanos, enteros) lo acepta `pg` tal cual.
 */
export function serializeValue(value: unknown, isJson: boolean): unknown {
  if (value === null || value === undefined) {
    return null;
  }
  // jsonb: re-stringificamos SIEMPRE (objetos, arrays y también primitivos como
  // strings/números, que como jsonb necesitan ir entre comillas/serializados).
  if (isJson) {
    return JSON.stringify(value);
  }
  return value;
}

// --------------------------------------------------------------------------
// Introspección del catálogo
// --------------------------------------------------------------------------

/**
 * Todas las tablas con al menos una FK que referencia `companies(id)`, con la(s)
 * columna(s) que hacen ese scoping (p.ej. `inventory_shares` tiene
 * `source_company_id` y `target_company_id`). Esta es la fuente dinámica de
 * "qué pertenece a un cliente".
 */
export async function getCompanyScopedTables(
  q: QueryFn,
): Promise<Array<{ table: string; companyColumns: string[] }>> {
  const rows = await q<{ table: string; col: string }>(
    `SELECT c.relname AS table, a.attname AS col
       FROM pg_constraint con
       JOIN pg_class c ON c.oid = con.conrelid
       JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = ANY (con.conkey)
      WHERE con.contype = 'f'
        AND con.confrelid = 'companies'::regclass
        AND c.relname <> 'companies'
      ORDER BY 1, 2`,
  );
  const byTable = new Map<string, string[]>();
  for (const r of rows) {
    const list = byTable.get(r.table) ?? [];
    list.push(r.col);
    byTable.set(r.table, list);
  }
  return Array.from(byTable, ([table, companyColumns]) => ({ table, companyColumns }));
}

/**
 * Aristas hijo→padre del grafo de FKs ENTRE las tablas dadas (incluye las que
 * apuntan a `companies` para forzar que la company se inserte primero; excluye
 * auto-referencias, que se resuelven a nivel de fila).
 */
export async function getForeignKeyEdges(
  q: QueryFn,
  tables: string[],
): Promise<Array<{ child: string; parent: string }>> {
  return q<{ child: string; parent: string }>(
    `SELECT c.relname AS child, cf.relname AS parent
       FROM pg_constraint con
       JOIN pg_class c ON c.oid = con.conrelid
       JOIN pg_class cf ON cf.oid = con.confrelid
      WHERE con.contype = 'f'
        AND c.relname = ANY ($1)
        AND cf.relname = ANY ($1)
        AND c.relname <> cf.relname`,
    [tables],
  );
}

/** Columnas auto-referenciales por tabla (p.ej. products.parent_id → products). */
export async function getSelfReferenceColumns(
  q: QueryFn,
  tables: string[],
): Promise<Record<string, string>> {
  const rows = await q<{ table: string; col: string }>(
    `SELECT c.relname AS table, a.attname AS col
       FROM pg_constraint con
       JOIN pg_class c ON c.oid = con.conrelid
       JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = ANY (con.conkey)
      WHERE con.contype = 'f'
        AND con.conrelid = con.confrelid
        AND c.relname = ANY ($1)`,
    [tables],
  );
  const map: Record<string, string> = {};
  for (const r of rows) {
    map[r.table] = r.col;
  }
  return map;
}

/** Conjunto de columnas json/jsonb por tabla (para serializar bien en INSERT). */
export async function getJsonColumns(
  q: QueryFn,
  tables: string[],
): Promise<Record<string, Set<string>>> {
  const rows = await q<{ table_name: string; column_name: string }>(
    `SELECT table_name, column_name
       FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = ANY ($1)
        AND data_type IN ('json', 'jsonb')`,
    [tables],
  );
  const map: Record<string, Set<string>> = {};
  for (const r of rows) {
    (map[r.table_name] ??= new Set()).add(r.column_name);
  }
  return map;
}

// --------------------------------------------------------------------------
// Orden de inserción
// --------------------------------------------------------------------------

/**
 * Orden topológico (Kahn) de las tablas: cada padre antes que sus hijos, para
 * no violar FKs al insertar. Las tablas que queden en un ciclo (no debería
 * haberlas salvo auto-referencias, ya excluidas) se anexan al final.
 */
export function topoSortTables(
  tables: string[],
  edges: Array<{ child: string; parent: string }>,
): string[] {
  const indegree = new Map<string, number>(tables.map((t) => [t, 0]));
  const children = new Map<string, string[]>(tables.map((t) => [t, []]));
  const present = new Set(tables);

  for (const { child, parent } of edges) {
    if (!present.has(child) || !present.has(parent)) {
      continue;
    }
    const siblings = children.get(parent) ?? [];
    siblings.push(child);
    children.set(parent, siblings);
    indegree.set(child, (indegree.get(child) ?? 0) + 1);
  }

  // Cola estable: respeta el orden de entrada entre nodos de mismo indegree.
  const queue = tables.filter((t) => (indegree.get(t) ?? 0) === 0);
  const ordered: string[] = [];
  while (queue.length) {
    const node = queue.shift() as string;
    ordered.push(node);
    for (const child of children.get(node) ?? []) {
      const deg = (indegree.get(child) ?? 0) - 1;
      indegree.set(child, deg);
      if (deg === 0) {
        queue.push(child);
      }
    }
  }

  // Anexa cualquier remanente (cobertura ante ciclos inesperados).
  for (const t of tables) {
    if (!ordered.includes(t)) {
      ordered.push(t);
    }
  }
  return ordered;
}

/**
 * Ordena las filas de una tabla auto-referencial para que cada padre se inserte
 * antes que sus hijos (p.ej. un producto base antes que sus presentaciones).
 */
export function sortSelfReferential(rows: BackupRow[], column: string): BackupRow[] {
  const byId = new Map<string, BackupRow>();
  for (const r of rows) {
    byId.set(String(r.id), r);
  }

  const emitted = new Set<string>();
  const out: BackupRow[] = [];

  const visit = (row: BackupRow, stack: Set<string>): void => {
    const id = String(row.id);
    if (emitted.has(id) || stack.has(id)) {
      return;
    }
    stack.add(id);
    const parentId = row[column] as string | number | null | undefined;
    if (parentId !== null && parentId !== undefined) {
      const parent = byId.get(String(parentId));
      if (parent) {
        visit(parent, stack);
      }
    }
    stack.delete(id);
    if (!emitted.has(id)) {
      emitted.add(id);
      out.push(row);
    }
  };

  for (const r of rows) {
    visit(r, new Set());
  }
  return out;
}
