import { Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';

import type { CreateRoleDto } from '../dto/create-role.dto';
import { Role } from '../entities/role.entity';
import { isValidPermissionKey, type PermissionKey } from '../internal/permission-catalog';
import { translateRoleConstraintError } from '../internal/role-constraint-errors';

/**
 * Crea un rol personalizado de la company autenticada.
 *
 *   - `company_id` se asigna desde el parámetro (req.user) — NUNCA del DTO.
 *   - `is_system = false` SIEMPRE: no se crean roles de sistema vía API.
 *   - `permissions` se deduplica y se filtra a keys válidas (defensa en
 *     profundidad; el DTO ya valida con `@IsIn`).
 *   - Nombre duplicado por company (case/trim-insensitive) → 409 vía el índice
 *     único funcional `idx_roles_company_name_unique`.
 *
 * Transacción: §8.8 del CLAUDE.md — el INSERT vive dentro de una transacción
 * aunque sea un solo paso, para que futuros side-effects hereden atomicidad.
 */
@Injectable()
export class CreateRoleAction {
  private readonly logger = new Logger(CreateRoleAction.name);

  constructor(private readonly dataSource: DataSource) {}

  async execute(dto: CreateRoleDto, companyId: number): Promise<Role> {
    const permissions = this.normalizePermissions(dto.permissions);

    return this.dataSource.transaction<Role>(async (manager) => {
      const role = manager.create(Role, {
        company_id: String(companyId),
        name: dto.name.trim(),
        color: dto.color ?? null,
        icon: dto.icon ?? null,
        permissions,
        is_system: false,
      });

      try {
        return await manager.save(Role, role);
      } catch (error) {
        translateRoleConstraintError(error, this.logger);
        throw error;
      }
    });
  }

  /** Deduplica preservando orden y filtra a keys válidas del catálogo. */
  private normalizePermissions(permissions: PermissionKey[]): PermissionKey[] {
    const seen = new Set<string>();
    const result: PermissionKey[] = [];
    for (const key of permissions) {
      if (isValidPermissionKey(key) && !seen.has(key)) {
        seen.add(key);
        result.push(key);
      }
    }
    return result;
  }
}
