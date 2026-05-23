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
 * Lee el ZIP recibido vía multipart y devuelve manifest + tablas.
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

  let manifest: MigrationManifest;
  try {
    const raw = await manifestFile.async('string');
    manifest = JSON.parse(raw) as MigrationManifest;
  } catch {
    throw new BadRequestException({
      message: 'manifest.json no es un JSON válido',
      payload: { code: 'INVALID_MANIFEST' },
    });
  }

  if (manifest.version !== 1) {
    throw new BadRequestException({
      message: `Versión de manifest no soportada: ${String(manifest.version)}`,
      payload: { code: 'UNSUPPORTED_MANIFEST_VERSION' },
    });
  }
  if (manifest.target !== 'pos_api_cloud') {
    throw new BadRequestException({
      message: `Target inválido en manifest: ${String(manifest.target)}`,
      payload: { code: 'INVALID_MANIFEST_TARGET' },
    });
  }

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

  return { manifest, tables };
}
