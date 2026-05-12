import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';

import type { UpdateSupplierDto } from '../dto/update-supplier.dto';
import { Supplier } from '../entities/supplier.entity';
import { findSupplierInCompany } from '../internal/supplier-lookups';

/**
 * Actualiza campos de perfil del supplier (legal_name, broker, address, phone,
 * doc_number, email).
 *
 * NO toca:
 *   - `accumulated_debt`, `credit_balance`: mutación reservada a fases 8/9.
 *   - `is_archived`: endpoint dedicado `PUT /:id/archive`.
 *   - `company_id`, `created_by*`: inmutables después del create.
 *
 * Paridad PlacePos: el endpoint local pre-filtra `is_archived = false`. Si el
 * supplier está archivado, responde 404. Espejamos ese comportamiento.
 *
 * Validación adicional: si llega `legal_name` definido pero blank, 400 con
 * mensaje exacto de PlacePos.
 */
@Injectable()
export class UpdateSupplierAction {
  constructor(private readonly dataSource: DataSource) {}

  async execute(id: number, dto: UpdateSupplierDto, companyId: number): Promise<Supplier> {
    return this.dataSource.transaction<Supplier>(async (manager) => {
      const existing = await findSupplierInCompany(manager, id, companyId);

      // Espejo de PlacePos: archived ⇒ 404 en update. Usamos el mismo mensaje
      // del lookup para no distinguir "archivado" de "inexistente".
      if (existing.is_archived) {
        throw new NotFoundException('Proveedor no encontrado');
      }

      const patch: Partial<Supplier> = {};
      if (dto.legal_name !== undefined) {
        const trimmed = dto.legal_name.trim();
        if (!trimmed) {
          throw new BadRequestException('La razón social es requerida');
        }
        patch.legal_name = trimmed;
      }
      if (dto.broker !== undefined) {
        patch.broker = dto.broker?.trim() || null;
      }
      if (dto.address !== undefined) {
        patch.address = dto.address?.trim() || null;
      }
      if (dto.phone !== undefined) {
        patch.phone = dto.phone?.trim() || null;
      }
      if (dto.doc_number !== undefined) {
        patch.doc_number = dto.doc_number?.trim() || null;
      }
      if (dto.email !== undefined) {
        patch.email = dto.email?.trim() || null;
      }

      if (Object.keys(patch).length === 0) {
        return existing;
      }

      await manager.update(Supplier, { id: String(id), company_id: String(companyId) }, patch);
      return findSupplierInCompany(manager, id, companyId);
    });
  }
}
