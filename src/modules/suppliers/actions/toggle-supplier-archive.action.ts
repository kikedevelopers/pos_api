import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { Supplier } from '../entities/supplier.entity';
import { findSupplierInCompany } from '../internal/supplier-lookups';

/**
 * Archive toggle (`PUT /suppliers/:id/archive`).
 *
 * Paridad PlacePos: el endpoint local SOLO archiva (no des-archiva); responde
 * 404 si el supplier ya está archived. Aquí seguimos esa semántica para que
 * el frontend Electron funcione idéntico.
 *
 * Si en algún momento se necesita un endpoint dual (toggle real), se añade un
 * `PUT /:id/unarchive` sin romper este. La diferencia con `customers`
 * (toggle puro) es intencional: PlacePos modela diferente cada dominio y
 * espejamos cada uno fielmente.
 *
 * Audit log post-commit.
 */
@Injectable()
export class ToggleSupplierArchiveAction {
  private readonly logger = new Logger(ToggleSupplierArchiveAction.name);

  constructor(private readonly dataSource: DataSource) {}

  async execute(id: number, companyId: number, actorId: number): Promise<{ archived: true }> {
    await this.dataSource.transaction(async (manager) => {
      const existing = await findSupplierInCompany(manager, id, companyId);

      // PlacePos: si ya está archived, responde 404 (`Proveedor no encontrado`).
      // Filtrado por la pre-condición del find local `is_archived = false`.
      if (existing.is_archived) {
        throw new NotFoundException('Proveedor no encontrado');
      }

      await manager.update(
        Supplier,
        { id: String(id), company_id: String(companyId) },
        { is_archived: true },
      );
    });

    this.logger.log({
      event: 'supplier.archived',
      actorId,
      supplierId: id,
      companyId,
    });

    // Paridad byte-por-byte con PlacePos: `{ archived: true }` como payload.
    return { archived: true };
  }
}
