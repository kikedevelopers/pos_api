import { QueryFailedError, type EntityManager } from 'typeorm';

import { Category } from '../../entities/category.entity';
import { PG_UNIQUE_VIOLATION } from '../constraint-errors';
import {
  ACCENTED,
  UNACCENTED,
  normalizeNameSql,
  resolveCategoryIdByName,
} from '../category-lookups';

// ---------------------------------------------------------------------------
// Fake EntityManager en memoria. El find-or-create real corre
// `translate(lower(btrim(name)))` en Postgres; aquí el fake reproduce esa
// normalización en JS con LA MISMA tabla ACCENTED/UNACCENTED que el SQL, para
// verificar el CONTRATO (scope por company, match case+acento-insensible, ñ
// intacta, create-on-miss, carrera 23505 → re-find) sin depender de BD. La
// cobertura con Postgres real vive en test/bulk-process-products.e2e-spec.ts.
// ---------------------------------------------------------------------------

// Espejo JS de translate(lower(btrim(x)), ACCENTED, UNACCENTED): minúsculas +
// trim + reemplazo char-a-char SOLO de las vocales acentuadas listadas. `ñ` no
// está en la tabla, así que se conserva (igual que en el SQL).
function normalizeLikeSql(value: string): string {
  const lowered = value.trim().toLowerCase();
  let out = '';
  for (const ch of lowered) {
    const idx = ACCENTED.indexOf(ch);
    out += idx >= 0 ? UNACCENTED[idx] : ch;
  }
  return out;
}

interface CategoryRow {
  id: string;
  company_id: string;
  name: string;
  is_archived: boolean;
}

interface ManagerOptions {
  seed?: Array<{ name: string; companyId: number; isArchived?: boolean }>;
  // Si se define, el PRIMER save lanza este error y luego inserta la fila
  // "ganadora" para simular una carrera contra otra transacción.
  throwOnFirstSave?: Error;
}

function buildManager(opts: ManagerOptions = {}) {
  const rows: CategoryRow[] = (opts.seed ?? []).map((s, i) => ({
    id: String(i + 1),
    company_id: String(s.companyId),
    name: s.name,
    is_archived: s.isArchived ?? false,
  }));
  let seq = rows.length;
  const saveCalls: Array<Partial<CategoryRow>> = [];
  let firstSave = true;

  const repo = {
    createQueryBuilder(_alias: string) {
      const params: Record<string, unknown> = {};
      const qb = {
        select: () => qb,
        where: (_sql: string, p?: Record<string, unknown>) => {
          Object.assign(params, p);
          return qb;
        },
        andWhere: (_sql: string, p?: Record<string, unknown>) => {
          Object.assign(params, p);
          return qb;
        },
        limit: () => qb,
        getRawOne: async (): Promise<{ id: string } | undefined> => {
          const companyId = String(params.companyId);
          const wanted = normalizeLikeSql(String(params.name));
          const match = rows.find(
            (r) =>
              r.company_id === companyId && !r.is_archived && normalizeLikeSql(r.name) === wanted,
          );
          return match ? { id: match.id } : undefined;
        },
      };
      return qb;
    },
  };

  const manager = {
    getRepository: () => repo,
    create: (_entity: unknown, obj: Partial<CategoryRow>) => obj,
    save: async (_entity: unknown, obj: Partial<CategoryRow>) => {
      saveCalls.push(obj);
      if (firstSave && opts.throwOnFirstSave) {
        firstSave = false;
        // Simula que la transacción rival ya insertó la categoría ganadora.
        rows.push({
          id: String(++seq),
          company_id: String(obj.company_id),
          name: String(obj.name),
          is_archived: false,
        });
        throw opts.throwOnFirstSave;
      }
      const row: CategoryRow = {
        id: String(++seq),
        company_id: String(obj.company_id),
        name: String(obj.name),
        is_archived: obj.is_archived ?? false,
      };
      rows.push(row);
      return row;
    },
  } as unknown as EntityManager;

  return { manager, rows, saveCalls };
}

const COMPANY = 8;

describe('resolveCategoryIdByName (pos_api)', () => {
  describe('nombre vacío → null (no crea)', () => {
    it.each([
      ['undefined', undefined],
      ['null', null],
      ['cadena vacía', ''],
      ['solo espacios', '   '],
    ])('%s → null', async (_label, value) => {
      const { manager, saveCalls } = buildManager();
      expect(await resolveCategoryIdByName(manager, value, COMPANY)).toBeNull();
      expect(saveCalls).toHaveLength(0);
    });
  });

  describe('create-on-miss', () => {
    it('crea la categoría con el nombre trimmed y la company, y devuelve su id', async () => {
      const { manager, saveCalls } = buildManager();
      const id = await resolveCategoryIdByName(manager, '  Condimentos  ', COMPANY);
      expect(id).toBe('1');
      expect(saveCalls).toHaveLength(1);
      expect(saveCalls[0]).toMatchObject({
        name: 'Condimentos',
        company_id: String(COMPANY),
        is_archived: false,
      });
    });
  });

  describe('match sin distinguir mayúsculas ni acentos (no duplica)', () => {
    it('"CONDIMENTOS" reutiliza "condimentos" existente', async () => {
      const { manager, saveCalls } = buildManager({
        seed: [{ name: 'condimentos', companyId: COMPANY }],
      });
      const id = await resolveCategoryIdByName(manager, 'CONDIMENTOS', COMPANY);
      expect(id).toBe('1');
      expect(saveCalls).toHaveLength(0);
    });

    it('"Condiméntos" (con tilde) reutiliza "Condimentos" existente', async () => {
      const { manager, saveCalls } = buildManager({
        seed: [{ name: 'Condimentos', companyId: COMPANY }],
      });
      const id = await resolveCategoryIdByName(manager, 'Condiméntos', COMPANY);
      expect(id).toBe('1');
      expect(saveCalls).toHaveLength(0);
    });
  });

  describe('aislamiento por company', () => {
    it('no reutiliza una categoría con el mismo nombre de OTRA company → crea una nueva', async () => {
      const { manager, saveCalls } = buildManager({
        seed: [{ name: 'Bebidas', companyId: 99 }],
      });
      const id = await resolveCategoryIdByName(manager, 'Bebidas', COMPANY);
      expect(id).toBe('2'); // nueva fila, no la de company 99
      expect(saveCalls).toHaveLength(1);
      expect(saveCalls[0]).toMatchObject({ company_id: String(COMPANY) });
    });
  });

  describe('categorías archivadas', () => {
    it('ignora una categoría archivada con el mismo nombre → crea una nueva activa', async () => {
      const { manager, saveCalls } = buildManager({
        seed: [{ name: 'Lácteos', companyId: COMPANY, isArchived: true }],
      });
      const id = await resolveCategoryIdByName(manager, 'lacteos', COMPANY);
      expect(id).toBe('2');
      expect(saveCalls).toHaveLength(1);
    });
  });

  describe('ñ se preserva (no es un acento)', () => {
    it('"Pina" NO hace match con "Piña" → crea una categoría distinta', async () => {
      const { manager, saveCalls } = buildManager({
        seed: [{ name: 'Piña', companyId: COMPANY }],
      });
      const id = await resolveCategoryIdByName(manager, 'Pina', COMPANY);
      expect(id).toBe('2');
      expect(saveCalls).toHaveLength(1);
    });
  });

  describe('carrera de concurrencia (23505)', () => {
    it('si el INSERT choca con el índice único, re-busca y devuelve el id ganador (idempotente)', async () => {
      const raceError = new QueryFailedError('insert', [], new Error('dup') as never);
      (raceError as unknown as { code: string }).code = PG_UNIQUE_VIOLATION;
      const { manager, saveCalls } = buildManager({ throwOnFirstSave: raceError });

      // El primer find falla (tabla vacía), el save lanza 23505, el re-find
      // encuentra la ganadora insertada por la "otra transacción".
      const id = await resolveCategoryIdByName(manager, 'Snacks', COMPANY);
      expect(id).toBe('1');
      expect(saveCalls).toHaveLength(1);
    });

    it('un error de save NO 23505 se propaga', async () => {
      const boom = new Error('conexión perdida');
      const { manager } = buildManager({ throwOnFirstSave: boom });
      await expect(resolveCategoryIdByName(manager, 'Snacks', COMPANY)).rejects.toThrow(
        'conexión perdida',
      );
    });
  });
});

describe('normalizeNameSql · invariantes de translate()', () => {
  it('ACCENTED y UNACCENTED tienen la MISMA longitud (requisito de translate)', () => {
    expect(ACCENTED.length).toBe(UNACCENTED.length);
  });

  it('genera la expresión SQL esperada (characterization)', () => {
    expect(normalizeNameSql('c.name')).toBe(
      `translate(lower(btrim(c.name)), '${ACCENTED}', '${UNACCENTED}')`,
    );
  });

  it('no incluye la ñ en la tabla de acentos', () => {
    expect(ACCENTED).not.toContain('ñ');
  });
});

// Referencia a la entidad para dejar explícito el tipo modelado por el fake.
void Category;
