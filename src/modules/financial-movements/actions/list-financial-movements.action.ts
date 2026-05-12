import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { AccountReference, FinancialMovement } from '../entities/financial-movement.entity';

/**
 * Lista movimientos donde la cuenta indicada aparece como SOURCE o
 * DESTINATION. Espeja `placepos/.../financial-movements.routes.ts` byte-
 * por-byte (orden DESC por `created_at`) PERO con el filtro `company_id`
 * añadido para multi-tenancy.
 *
 * Read puro — no requiere transacción. Usa QueryBuilder con `OR`
 * sobre (source, destination) para que un único plan de query aproveche
 * los dos índices compuestos:
 *
 *   - `idx_financial_movements_company_source(company_id, source_type, source_id)`
 *   - `idx_financial_movements_company_destination(company_id, destination_type, destination_id)`
 */
@Injectable()
export class ListFinancialMovementsAction {
  constructor(
    @InjectRepository(FinancialMovement)
    private readonly repo: Repository<FinancialMovement>,
  ) {}

  async execute(
    companyId: number,
    accountType: AccountReference,
    accountId: number,
  ): Promise<FinancialMovement[]> {
    return this.repo
      .createQueryBuilder('m')
      .where('m.company_id = :companyId', { companyId: String(companyId) })
      .andWhere(
        `(
          (m.source_type = :accountType AND m.source_id = :accountId)
          OR (m.destination_type = :accountType AND m.destination_id = :accountId)
        )`,
        { accountType, accountId: String(accountId) },
      )
      .orderBy('m.created_at', 'DESC')
      .getMany();
  }
}
