import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';

import type { UpdateCustomerDto } from '../dto/update-customer.dto';
import { Customer } from '../entities/customer.entity';
import { findCustomerInCompany } from '../internal/customer-lookups';

/**
 * Actualiza campos de PERFIL del customer (person_type, name, email, phone,
 * doc_number, address).
 *
 * NO toca:
 *   - `balance`: mutación reservada a fases 6/8/9 (DTO ya lo excluye).
 *   - `is_archived`: endpoint dedicado `PUT /:id/archive`.
 *   - `company_id`, `created_by*`: inmutables después del create.
 *
 * Defensa en profundidad: el WHERE del UPDATE filtra por `(id, company_id)`,
 * de modo que aunque un bug pasara un id de otra company, la query
 * actualizaría 0 filas y el re-fetch tiraría 404. La pre-validación con
 * `findCustomerInCompany` da el 404 antes y evita el UPDATE vacío.
 *
 * Transacción: la pre-verificación + UPDATE + re-fetch comparten manager
 * (snapshot isolation). Sin transacción, una eliminación concurrente entre
 * pasos generaría 200 con re-fetch fallando o UX confusa.
 */
@Injectable()
export class UpdateCustomerAction {
  constructor(private readonly dataSource: DataSource) {}

  async execute(id: number, dto: UpdateCustomerDto, companyId: number): Promise<Customer> {
    return this.dataSource.transaction<Customer>(async (manager) => {
      const existing = await findCustomerInCompany(manager, id, companyId);

      // Construimos el patch solo con campos DEFINIDOS para no nullificar
      // accidentalmente columnas no enviadas. `null` explícito en email/phone/
      // doc_number/address sí se respeta — el cliente puede limpiar campos.
      const patch: Partial<Customer> = {};
      if (dto.person_type !== undefined) {
        patch.person_type = dto.person_type;
      }
      if (dto.name !== undefined) {
        patch.name = dto.name.trim();
      }
      if (dto.email !== undefined) {
        patch.email = dto.email?.trim() || null;
      }
      if (dto.phone !== undefined) {
        patch.phone = dto.phone?.trim() || null;
      }
      if (dto.doc_number !== undefined) {
        patch.doc_number = dto.doc_number?.trim() || null;
      }
      if (dto.address !== undefined) {
        patch.address = dto.address?.trim() || null;
      }

      if (Object.keys(patch).length === 0) {
        // PUT con body vacío: idempotente, devolvemos el row tal cual.
        // Mismo comportamiento que el módulo employees y que PlacePos.
        return existing;
      }

      await manager.update(Customer, { id: String(id), company_id: String(companyId) }, patch);
      return findCustomerInCompany(manager, id, companyId);
    });
  }
}
