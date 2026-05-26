import { BadRequestException, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';

import type { AuthUser } from '@/common/types/jwt-payload.type';

import { ImportZipAction } from '@/modules/migration-import/actions/import-zip.action';
import type { MigrationSummaryDto } from '@/modules/migration-import/dto/migration-summary.dto';
import { SELECTABLE_MODULES } from '@/modules/migration-import/internal/manifest.types';
import type { SelectableModule } from '@/modules/migration-import/internal/manifest.types';
import { parseBackupZip } from '@/modules/migration-import/internal/zip-reader';

/**
 * Restaura un backup NATIVO de placepos sobre la PROPIA empresa del owner
 * autenticado (el `company_id` viene del JWT, nunca del ZIP).
 *
 * Diferencias con el import admin (`ImportZipAction.execute`):
 *   - NO crea ni resuelve empresa por email/document_number: la empresa es la
 *     del JWT y se conserva su identidad (id, nombre, owner). Se ignoran
 *     `companies.json` / `users.json` del ZIP.
 *   - Reemplaza SOLO los datos de negocio (catálogo, clientes, proveedores,
 *     empleados, ventas, compras, gastos) vía `importModulesIntoCompany` con
 *     `wipe: true`, que borra los hijos del tenant antes de recargar.
 *   - Importa TODOS los `SELECTABLE_MODULES`: un restore trae todo, no hay
 *     selección parcial.
 *
 * Aislamiento transaccional: `READ COMMITTED` (default de PostgreSQL). El wipe
 * + recarga van en una sola transacción (atómico: o se restaura completo, o
 * rollback). No se eleva a `SERIALIZABLE` porque el borrado está estrictamente
 * scoped por `company_id` (multi-tenant: jamás toca otra empresa) y no hay
 * lectura-modificación-escritura concurrente sobre las mismas filas que exija
 * prevenir anomalías de serialización; un owner restaurando su propia empresa
 * es una operación administrativa puntual.
 */
@Injectable()
export class RestoreBackupAction {
  constructor(
    private readonly dataSource: DataSource,
    private readonly importZipAction: ImportZipAction,
  ) {}

  async execute(
    fileBuffer: Buffer | undefined,
    companyId: number,
    user: AuthUser,
  ): Promise<MigrationSummaryDto> {
    if (!fileBuffer || fileBuffer.length === 0) {
      throw new BadRequestException({
        message: 'El campo `file` es obligatorio y no puede estar vacío',
        payload: { code: 'MISSING_FILE' },
      });
    }

    const startedAt = Date.now();

    // Reutiliza el manejo de errores del parser (INVALID_ZIP, MISSING_MANIFEST,
    // UNSUPPORTED_MANIFEST_VERSION, INVALID_TABLE_JSON, ...).
    const zip = await parseBackupZip(fileBuffer);

    const companyIdStr = String(companyId);
    const ownerUserIdStr = String(user.user_id);
    const ownerFullName = `${user.name} ${user.lastname}`.trim();
    // Restore = todo el negocio. Sin selección parcial.
    const selectedModules: SelectableModule[] = [...SELECTABLE_MODULES];

    const inserted: Record<string, number> = {};
    const warnings: string[] = [];

    await this.dataSource.transaction(async (manager) => {
      // `wipe: true` → borra los datos hijos del tenant (conservando la fila
      // `companies` y el owner) y recarga, todo atómico. NO se toca la
      // identidad de la empresa cloud ni el owner: companies.json/users.json
      // del ZIP se ignoran por completo.
      await this.importZipAction.importModulesIntoCompany(manager, {
        zip,
        companyId: companyIdStr,
        ownerUserId: ownerUserIdStr,
        ownerFullName,
        selectedModules,
        inserted,
        warnings,
        wipe: true,
      });
    });

    // El manifest del backup puede traer warnings — los anexamos al final.
    for (const w of zip.manifest.warnings) {
      warnings.push(w);
    }

    return {
      company_id_real: companyIdStr,
      user_id_real: ownerUserIdStr,
      // El restore reemplaza los datos de la empresa del JWT; reportamos su id
      // como "reemplazado" (estable, coincide con company_id_real).
      replaced_company_id: companyIdStr,
      inserted,
      warnings,
      duration_ms: Date.now() - startedAt,
    };
  }
}
