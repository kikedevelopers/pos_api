import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';

import type { UpdateBankDto } from '../dto/update-bank.dto';
import { Bank } from '../entities/bank.entity';
import { translateBankConstraintError } from '../internal/constraint-errors';
import { findBankInCompany } from '../internal/bank-lookups';

/**
 * Actualiza campos de perfil del bank (name / account_number / account_type
 * / available_in_pos). NO toca `balance` ni `is_archived`.
 *
 * Espejo de PlacePos `PUT /banks/:id`. Verificación de existencia previa al
 * UPDATE (404 si el id pertenece a otra company o está archivado).
 *
 * Filtro multi-tenant en el WHERE del UPDATE (defensa en profundidad): si
 * por algún bug el id de otra company se colara, la query actualizaría 0
 * filas y el `findBankInCompany` previo ya habría tirado 404.
 */
@Injectable()
export class UpdateBankAction {
  constructor(private readonly dataSource: DataSource) {}

  async execute(id: number, dto: UpdateBankDto, companyId: number): Promise<Bank> {
    return this.dataSource.transaction<Bank>(async (manager) => {
      // Pre-validar existencia + tenancy + activo. PlacePos solo permite
      // updates sobre banks no archivados.
      await findBankInCompany(manager, id, companyId, { requireActive: true });

      try {
        await manager.update(
          Bank,
          { id: String(id), company_id: String(companyId) },
          {
            name: dto.name,
            account_number: dto.account_number,
            account_type: dto.account_type,
            available_in_pos: dto.available_in_pos ?? false,
          },
        );
      } catch (error) {
        translateBankConstraintError(error);
        throw error;
      }

      return findBankInCompany(manager, id, companyId);
    });
  }
}
