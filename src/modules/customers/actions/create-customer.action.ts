import { Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';

import type { CreateCustomerDto } from '../dto/create-customer.dto';
import { Customer, PersonType } from '../entities/customer.entity';

/**
 * Datos del actor (User u Employee) que el controller propaga al action.
 * Espejo del `EmployeeCreator` del módulo employees. Mantiene la firma
 * desacoplada de la forma exacta del JWT.
 */
export interface CustomerCreator {
  id: number;
  fullName: string;
}

/**
 * Crea un customer.
 *
 * Reglas duras:
 *
 *   - `company_id`, `created_by`, `created_by_id` se asignan SIEMPRE desde
 *     los parámetros del action (que vienen del JWT), NUNCA del DTO.
 *   - `balance` se inicializa a 0. El DTO no acepta este campo (whitelist
 *     strippe cualquier valor que el cliente intente enviar).
 *   - `is_archived` se inicializa a false. La capacidad cloud de archivar
 *     vive en un endpoint dedicado.
 *
 * Transacción: el INSERT vive dentro de `dataSource.transaction` aunque sea
 * "un solo paso". Razón: §8.8 del CLAUDE.md — defensa en profundidad para que
 * futuros side-effects (triggers, FK cascade, audit en DB) hereden atomicidad
 * automáticamente.
 */
@Injectable()
export class CreateCustomerAction {
  private readonly logger = new Logger(CreateCustomerAction.name);

  constructor(private readonly dataSource: DataSource) {}

  async execute(
    dto: CreateCustomerDto,
    companyId: number,
    createdBy: CustomerCreator,
  ): Promise<Customer> {
    const saved = await this.dataSource.transaction<Customer>(async (manager) => {
      const customer = manager.create(Customer, {
        company_id: String(companyId),
        person_type: dto.person_type ?? PersonType.INDIVIDUAL,
        name: dto.name.trim(),
        email: dto.email?.trim() || null,
        phone: dto.phone?.trim() || null,
        doc_number: dto.doc_number?.trim() || null,
        address: dto.address?.trim() || null,
        // balance NO viene del DTO. Se fija a 0 en el create. Mutación en
        // fases 6/8/9.
        balance: 0,
        // advance_balance es NOT NULL en la BD. Hay que fijarlo explícito: la
        // columna tiene NumericTransformer, así que TypeORM la incluye en el
        // INSERT con `null` (undefined→null) en vez de usar el DEFAULT 0, lo
        // que viola la restricción NOT NULL. Mismo motivo que `balance`.
        advance_balance: 0,
        is_archived: false,
        created_by: createdBy.fullName,
        created_by_id: String(createdBy.id),
      });

      return manager.save(Customer, customer);
    });

    // Audit log post-commit. Si la transacción falla, este log NO se emite.
    this.logger.log({
      event: 'customer.created',
      actorId: createdBy.id,
      customerId: Number(saved.id),
      companyId,
    });

    return saved;
  }
}
