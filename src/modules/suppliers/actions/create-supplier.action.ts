import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';

import type { CreateSupplierDto } from '../dto/create-supplier.dto';
import { Supplier } from '../entities/supplier.entity';

/**
 * Actor (User o Employee) que crea el supplier. Lo propaga el controller.
 */
export interface SupplierCreator {
  id: number;
  fullName: string;
}

/**
 * Crea un supplier.
 *
 * Reglas duras:
 *
 *   - `company_id`, `created_by`, `created_by_id` se asignan SIEMPRE desde el
 *     contexto del actor autenticado. Nunca del DTO.
 *   - `accumulated_debt` y `credit_balance` se inicializan a 0. Mutación
 *     reservada a fases 8 y 9.
 *   - `is_archived = false` por default.
 *
 * Validación adicional: PlacePos exige `legal_name` no-blank y devuelve 400
 * si llega vacío/whitespace. El DTO (`@IsNotEmpty` + `@MinLength(1)`) ya lo
 * cubre, pero replicamos la validación pre-flight con mensaje exacto de
 * PlacePos como red de seguridad por si se invoca el action desde otro
 * caller (queue worker, test).
 *
 * Transacción: §8.8 — defensa en profundidad para futuros triggers/cascades.
 */
@Injectable()
export class CreateSupplierAction {
  private readonly logger = new Logger(CreateSupplierAction.name);

  constructor(private readonly dataSource: DataSource) {}

  async execute(
    dto: CreateSupplierDto,
    companyId: number,
    createdBy: SupplierCreator,
  ): Promise<Supplier> {
    const legalName = dto.legal_name?.trim();
    if (!legalName) {
      // Mensaje espejo de PlacePos para que el frontend pueda branchear por
      // substring si lo necesita.
      throw new BadRequestException('La razón social es requerida');
    }

    const saved = await this.dataSource.transaction<Supplier>(async (manager) => {
      const supplier = manager.create(Supplier, {
        company_id: String(companyId),
        legal_name: legalName,
        broker: dto.broker?.trim() || null,
        address: dto.address?.trim() || null,
        phone: dto.phone?.trim() || null,
        doc_number: dto.doc_number?.trim() || null,
        email: dto.email?.trim() || null,
        accumulated_debt: 0,
        credit_balance: 0,
        // Paridad placepos: el cliente envía un array (posiblemente vacío);
        // si no llega el campo, persistimos `[]`.
        payment_accounts: dto.payment_accounts ?? [],
        is_archived: false,
        created_by: createdBy.fullName,
        created_by_id: String(createdBy.id),
      });

      return manager.save(Supplier, supplier);
    });

    this.logger.log({
      event: 'supplier.created',
      actorId: createdBy.id,
      supplierId: Number(saved.id),
      companyId,
    });

    return saved;
  }
}
