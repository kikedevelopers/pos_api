import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { Company } from '@/modules/companies/entities/company.entity';
import { User, UserType } from '@/modules/users/entities/user.entity';

import type { UpdateBranchesDto } from '../dto/update-branches.dto';

export interface UpdateBranchesResult {
  branchesEnabled: boolean;
  branchesAllowed: number;
}

/**
 * Configura el gating de sucursales del owner de un tenant desde el panel
 * superadmin (firmado). Setea `branches_enabled`/`branches_allowed` en el OWNER.
 *
 * Reglas:
 *   - El `companyId` debe ser el negocio PRINCIPAL del tenant (`is_branch=false`).
 *     Si es una sucursal → 400 (las sucursales no tienen owner por company_id).
 *   - `enabled ⇒ allowed >= 1`.
 *   - NO auto-suspende sucursales al reducir el límite: la reconciliación
 *     (elegir cuáles conservar) la hace el OWNER desde su POS. El backend igual
 *     respeta el límite en create/switch aunque exista exceso transitorio.
 *
 * Transacción SERIALIZABLE: escritura de control de acceso; evita pisar cambios
 * concurrentes sobre la fila del owner.
 */
@Injectable()
export class UpdateBranchesAction {
  private readonly logger = new Logger(UpdateBranchesAction.name);

  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  async execute(companyId: number, dto: UpdateBranchesDto): Promise<UpdateBranchesResult> {
    if (dto.enabled && dto.allowed < 1) {
      throw new BadRequestException(
        'Si habilitas sucursales, la cantidad permitida debe ser al menos 1.',
      );
    }

    return this.dataSource.transaction('SERIALIZABLE', async (manager) => {
      const companyRepo = manager.getRepository(Company);
      const userRepo = manager.getRepository(User);

      const company = await companyRepo.findOne({ where: { id: String(companyId) } });
      if (!company) {
        throw new NotFoundException(`Company ${companyId} no existe.`);
      }
      if (company.is_branch) {
        throw new BadRequestException(
          'El gating de sucursales se configura sobre el negocio principal, no sobre una sucursal.',
        );
      }

      const owner = await userRepo.findOne({
        where: { company_id: String(companyId), type: UserType.OWNER },
      });
      if (!owner) {
        throw new NotFoundException(`La company ${companyId} no tiene owner.`);
      }

      owner.branches_enabled = dto.enabled;
      owner.branches_allowed = dto.allowed;
      await userRepo.save(owner);

      this.logger.log({
        event: 'superadmin.branches.updated',
        companyId,
        ownerUserId: Number(owner.id),
        enabled: dto.enabled,
        allowed: dto.allowed,
      });

      return { branchesEnabled: owner.branches_enabled, branchesAllowed: owner.branches_allowed };
    });
  }
}
