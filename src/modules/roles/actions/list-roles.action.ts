import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import type { Repository } from 'typeorm';

import { Role } from '../entities/role.entity';
import type { RoleListRow } from '../dto/role-response.dto';

/**
 * Lista los roles de una company con su `employee_count` (nº de empleados
 * ACTIVOS asignados). Orden: roles de sistema primero, luego por nombre
 * (case/trim-insensitive). Endpoint `GET /roles`.
 *
 * Una sola query con `LEFT JOIN` agregado para evitar N+1 (un COUNT por rol).
 * El `LEFT JOIN` incluye roles sin empleados (count = 0). El predicado de join
 * `e.company_id = r.company_id` es redundante con `e.role_id = r.id` (un rol
 * pertenece a una sola company) pero blinda el aislamiento multi-tenant.
 *
 * Índices usados: `idx_roles_company_id` (WHERE), `idx_employees_role_id`
 * (JOIN). Read puro — no requiere transacción.
 */
@Injectable()
export class ListRolesAction {
  constructor(
    @InjectRepository(Role)
    private readonly repo: Repository<Role>,
  ) {}

  async execute(companyId: number): Promise<RoleListRow[]> {
    return this.repo.manager.query(
      `SELECT r.id,
              r.name,
              r.color,
              r.icon,
              r.permissions,
              r.is_system,
              r.is_editable,
              r.created_at,
              r.updated_at,
              COUNT(e.id) FILTER (WHERE e.is_archived = false)::int AS employee_count
       FROM roles r
       LEFT JOIN employees e
         ON e.role_id = r.id AND e.company_id = r.company_id
       WHERE r.company_id = $1
       GROUP BY r.id
       ORDER BY r.is_system DESC, lower(btrim(r.name)) ASC`,
      [String(companyId)],
    );
  }
}
