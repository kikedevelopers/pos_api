import { BadRequestException } from '@nestjs/common';
import JSZip from 'jszip';

import {
  type MigrationManifest,
  type ParsedZip,
  type ZipRow,
  type ZipTableName,
  ZIP_TABLE_NAMES,
} from './manifest.types';

/**
 * Carga el buffer como ZIP y lee/parsea su `manifest.json`. Falla con
 * `BadRequestException` (`INVALID_ZIP` / `MISSING_MANIFEST` / `INVALID_MANIFEST`)
 * en los mismos casos que el reader original. Reutilizado por ambos parsers
 * (migración admin y restore nativo de placepos).
 */
async function loadZipAndManifest(
  buffer: Buffer,
): Promise<{ zip: JSZip; manifest: Record<string, unknown> }> {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(buffer);
  } catch {
    throw new BadRequestException({
      message: 'El archivo no es un ZIP válido',
      payload: { code: 'INVALID_ZIP' },
    });
  }

  const manifestFile = zip.file('manifest.json');
  if (!manifestFile) {
    throw new BadRequestException({
      message: 'El ZIP no contiene manifest.json',
      payload: { code: 'MISSING_MANIFEST' },
    });
  }

  let manifest: Record<string, unknown>;
  try {
    const raw = await manifestFile.async('string');
    manifest = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    throw new BadRequestException({
      message: 'manifest.json no es un JSON válido',
      payload: { code: 'INVALID_MANIFEST' },
    });
  }

  return { zip, manifest };
}

/**
 * Lee todas las `data/<tabla>.json` declaradas en `ZIP_TABLE_NAMES` y devuelve
 * el `Map` de tablas. La estructura `data/*.json` es IDÉNTICA en el ZIP de
 * migración admin y en el backup NATIVO de placepos, así que esta lógica se
 * comparte tal cual.
 *
 * Tablas presentes pero no declaradas en `ZIP_TABLE_NAMES` se ignoran
 * (forward-compat). Tablas declaradas pero ausentes en el ZIP se tratan como
 * vacías.
 */
async function readTables(zip: JSZip): Promise<Map<ZipTableName, ZipRow[]>> {
  const tables = new Map<ZipTableName, ZipRow[]>();
  for (const name of ZIP_TABLE_NAMES) {
    const file = zip.file(`data/${name}.json`);
    if (!file) {
      tables.set(name, []);
      continue;
    }
    let raw: string;
    try {
      raw = await file.async('string');
    } catch {
      throw new BadRequestException({
        message: `No se pudo leer data/${name}.json del ZIP`,
        payload: { code: 'UNREADABLE_TABLE', field: name },
      });
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new BadRequestException({
        message: `data/${name}.json no es JSON válido`,
        payload: { code: 'INVALID_TABLE_JSON', field: name },
      });
    }
    if (!Array.isArray(parsed)) {
      throw new BadRequestException({
        message: `data/${name}.json no es un array`,
        payload: { code: 'TABLE_NOT_ARRAY', field: name },
      });
    }
    tables.set(name, parsed as ZipRow[]);
  }
  return tables;
}

/**
 * Extrae el array de `warnings` del manifest de forma defensiva. El backup
 * nativo de placepos NO emite `warnings`; en ese caso devolvemos `[]`.
 */
function readManifestWarnings(manifest: Record<string, unknown>): string[] {
  const raw = manifest.warnings;
  if (Array.isArray(raw)) {
    return raw.filter((w): w is string => typeof w === 'string');
  }
  return [];
}

/**
 * Lee el ZIP de MIGRACIÓN (kdevs-admin / placepos `cloudMigration/buildZip.ts`)
 * recibido vía multipart y devuelve manifest + tablas.
 *
 * Falla con `BadRequestException` si:
 *   - El buffer no es un ZIP válido.
 *   - Falta `manifest.json`.
 *   - El manifest tiene `version != 1` o `target != 'pos_api_cloud'`.
 *   - Alguna `data/<tabla>.json` no es un array JSON.
 *
 * Tablas declaradas en el manifest pero no presentes como archivo se tratan
 * como vacías. Tablas presentes pero no declaradas en `ZIP_TABLE_NAMES` se
 * ignoran (forward-compat: el migrador podría añadir tablas nuevas y el
 * endpoint vieja debería seguir importando lo que conoce).
 */
export async function parseMigrationZip(buffer: Buffer): Promise<ParsedZip> {
  const { zip, manifest: rawManifest } = await loadZipAndManifest(buffer);

  if (rawManifest.version !== 1) {
    throw new BadRequestException({
      message: `Versión de manifest no soportada: ${String(rawManifest.version)}`,
      payload: { code: 'UNSUPPORTED_MANIFEST_VERSION' },
    });
  }
  if (rawManifest.target !== 'pos_api_cloud') {
    throw new BadRequestException({
      message: `Target inválido en manifest: ${String(rawManifest.target)}`,
      payload: { code: 'INVALID_MANIFEST_TARGET' },
    });
  }

  const manifest = rawManifest as unknown as MigrationManifest;
  const tables = await readTables(zip);
  return { manifest, tables };
}

/**
 * Lee el ZIP de BACKUP NATIVO de placepos (el que genera el cliente de
 * escritorio en `backup.routes.ts`) recibido vía multipart y devuelve
 * manifest + tablas.
 *
 * A diferencia del ZIP de migración admin, el backup nativo NO trae `target`
 * ni `source` (solo `version` / `name` / `generated_at` / `generated_by` /
 * `tables`). La estructura `data/*.json` es IDÉNTICA, así que reutilizamos
 * `readTables`. Solo se exige `version === 1`.
 *
 * Falla con `BadRequestException` si:
 *   - El buffer no es un ZIP válido (`INVALID_ZIP`).
 *   - Falta `manifest.json` (`MISSING_MANIFEST`).
 *   - El manifest no es JSON (`INVALID_MANIFEST`).
 *   - `version != 1` (`UNSUPPORTED_MANIFEST_VERSION`).
 *   - Alguna `data/<tabla>.json` no es un array JSON.
 *
 * Devuelve el mismo `ParsedZip`; el `manifest` se normaliza a la forma
 * `MigrationManifest` con un `target` sintético (`'pos_api_cloud'`) y `source`
 * mínimo, dado que el pipeline de inserción es agnóstico de esos campos.
 */
export async function parseBackupZip(buffer: Buffer): Promise<ParsedZip> {
  const { zip, manifest: rawManifest } = await loadZipAndManifest(buffer);

  if (rawManifest.version !== 1) {
    throw new BadRequestException({
      message: `Versión de backup no soportada: ${String(rawManifest.version)}`,
      payload: { code: 'UNSUPPORTED_MANIFEST_VERSION' },
    });
  }

  const tables = await readTables(zip);

  // Normalizamos a `MigrationManifest`. El backup nativo no trae target/source;
  // los rellenamos con valores sintéticos porque el pipeline de inserción no
  // los consume (solo lee `manifest.warnings`).
  const generatedBy = rawManifest.generated_by;
  const manifest: MigrationManifest = {
    version: 1,
    target: 'pos_api_cloud',
    name: typeof rawManifest.name === 'string' ? rawManifest.name : 'placepos-backup',
    generated_at:
      typeof rawManifest.generated_at === 'string'
        ? rawManifest.generated_at
        : new Date().toISOString(),
    generated_by:
      generatedBy !== null &&
      typeof generatedBy === 'object' &&
      'id' in generatedBy &&
      'full_name' in generatedBy
        ? (generatedBy as MigrationManifest['generated_by'])
        : { id: '0', full_name: '' },
    source: { mongo_company_id: '', owner_email: '' },
    tables: Array.isArray(rawManifest.tables)
      ? (rawManifest.tables as MigrationManifest['tables'])
      : [],
    warnings: readManifestWarnings(rawManifest),
  };

  return { manifest, tables };
}
