import { ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, In } from 'typeorm';

import { CompanyMember } from '@/modules/companies/entities/company-member.entity';
import { Company } from '@/modules/companies/entities/company.entity';
import { User } from '@/modules/users/entities/user.entity';

import type { SetActiveBranchesDto } from '../dto/set-active-branches.dto';

/**
 * Reconciliación de sucursales activas por el OWNER (no admin). Cuando el admin
 * reduce el límite, el owner elige cuáles conservar; el resto queda suspendido
 * (`is_active=false`, datos intactos, reversible).
 *
 * Reglas [SEGURIDAD, backend autoritativo]:
 *   - No más de `branches_allowed` sucursales activas.
 *   - Todos los ids deben ser sucursales del propio owner (anti-IDOR).
 *   - El negocio principal nunca se suspende (no se incluye ni cuenta).
 *
 * Transacción SERIALIZABLE: evita pisar cambios concurrentes del límite/estado.
 */
@Injectable()
export class SetActiveBranchesAction {
  private readonly logger = new Logger(SetActiveBranchesAction.name);

  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  async execute(userId: number, dto: SetActiveBranchesDto): Promise<void> {
    await this.dataSource.transaction('SERIALIZABLE', async (manager) => {
      const owner = await manager.getRepository(User).findOne({ where: { id: String(userId) } });
      if (!owner) {
        throw new NotFoundException('Usuario no encontrado');
      }

      const activeSet = new Set(dto.active_company_ids.map(String));
      if (activeSet.size > owner.branches_allowed) {
        throw new ForbiddenException(
          `Solo puedes mantener ${owner.branches_allowed} sucursal(es) activa(s).`,
        );
      }

      const members = await manager.getRepository(CompanyMember).find({
        where: { user_id: String(userId) },
      });
      const companies = await manager.getRepository(Company).find({
        where: { id: In(members.map((m) => m.company_id)) },
      });
      const branchIds = new Set(companies.filter((c) => c.is_branch).map((c) => c.id));

      // Anti-IDOR: cada id elegido debe ser una sucursal del owner.
      for (const id of activeSet) {
        if (!branchIds.has(id)) {
          throw new ForbiddenException('Una de las sucursales seleccionadas no te pertenece.');
        }
      }

      // Marcar: sucursales elegidas activas; resto suspendidas. El principal
      // (is_branch=false) no se toca (siempre activo).
      for (const m of members) {
        if (!branchIds.has(m.company_id)) {
          continue;
        }
        const shouldBeActive = activeSet.has(m.company_id);
        if (m.is_active !== shouldBeActive) {
          m.is_active = shouldBeActive;
          await manager.getRepository(CompanyMember).save(m);
        }
      }

      this.logger.log({
        event: 'branch.active_set',
        userId,
        activeCount: activeSet.size,
      });
    });
  }
}
