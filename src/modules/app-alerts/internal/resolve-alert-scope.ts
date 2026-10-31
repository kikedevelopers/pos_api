import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import type { Repository } from 'typeorm';

import type { AuthUser } from '@/common/types/jwt-payload.type';
import { CompanyMember } from '@/modules/companies/entities/company-member.entity';
import { ResolveEffectivePermissionsAction } from '@/modules/roles/actions/resolve-effective-permissions.action';
import { PERMISSION_KEYS } from '@/modules/roles/internal/permission-catalog';

import type { AlertScope } from './alert-scope';
import { hiddenAlertPrefixFor } from './alert-visibility';

/**
 * Arma el `AlertScope` del usuario que pide sus alertas:
 *   - Tipos ocultos según su nivel (las del agente son de nivel admin).
 *   - Si es DUEÑO, sus otros negocios ACTIVOS (`company_members`): de ellos ve
 *     los pedidos del agente. Una sucursal suspendida no avisa.
 */
@Injectable()
export class ResolveAlertScopeAction {
  constructor(
    private readonly resolvePermissions: ResolveEffectivePermissionsAction,
    @InjectRepository(CompanyMember)
    private readonly members: Repository<CompanyMember>,
  ) {}

  async execute(user: AuthUser, companyId: number): Promise<AlertScope> {
    const granted = new Set<string>(await this.resolvePermissions.execute(user));
    const isAdminLevel = PERMISSION_KEYS.every((key) => granted.has(key));
    const agentCompanyIds =
      user.type === 'owner'
        ? (
            await this.members.find({
              where: { user_id: String(user.user_id), is_active: true },
              select: { company_id: true },
            })
          )
            .map((member) => Number(member.company_id))
            .filter((id) => Number.isSafeInteger(id) && id !== companyId)
        : [];
    return { companyId, hiddenTypePrefix: hiddenAlertPrefixFor(isAdminLevel), agentCompanyIds };
  }
}
