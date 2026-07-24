import { Injectable } from '@nestjs/common';

import type { AuthUser } from '@/common/types/jwt-payload.type';

import { AcceptAgreementAction } from './actions/accept-agreement.action';
import { ListAcceptancesAction } from './actions/list-acceptances.action';
import { AcceptAgreementDto } from './dto/accept-agreement.dto';
import { AgreementAcceptance } from './entities/agreement-acceptance.entity';

/**
 * Facade del módulo `agreements`. Sin lógica: delega en las actions.
 */
@Injectable()
export class AgreementsService {
  constructor(
    private readonly listAcceptancesAction: ListAcceptancesAction,
    private readonly acceptAgreementAction: AcceptAgreementAction,
  ) {}

  listAcceptances(companyId: number, user: AuthUser): Promise<AgreementAcceptance[]> {
    return this.listAcceptancesAction.execute(companyId, user);
  }

  accept(
    dto: AcceptAgreementDto,
    companyId: number,
    user: AuthUser,
  ): Promise<AgreementAcceptance> {
    return this.acceptAgreementAction.execute(dto, companyId, user);
  }
}
