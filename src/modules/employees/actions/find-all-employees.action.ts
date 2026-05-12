import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import type { Repository } from 'typeorm';

import { Employee } from '@/modules/employees/entities/employee.entity';

/**
 * Lista employees ACTIVOS (`is_archived = false`) de una company, ordenados
 * por `created_at DESC`. Endpoint `GET /employees`.
 *
 * Paridad PlacePos: espeja `placepos/src/main/server/routes/employees.routes.ts`
 * (`ORDER BY created_at DESC`). El frontend asume orden de creación
 * descendente; cambiarlo por `name ASC` reordena la lista visible y rompe la
 * regla #1 del proyecto (paridad byte-por-byte).
 *
 * Read puro — no requiere transacción.
 */
@Injectable()
export class FindAllEmployeesAction {
  constructor(
    @InjectRepository(Employee)
    private readonly repo: Repository<Employee>,
  ) {}

  async execute(companyId: number): Promise<Employee[]> {
    return this.repo.find({
      where: { company_id: String(companyId), is_archived: false },
      order: { created_at: 'DESC' },
    });
  }
}
