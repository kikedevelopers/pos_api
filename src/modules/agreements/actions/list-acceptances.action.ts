import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import type { Repository } from 'typeorm';

import type { AuthUser } from '@/common/types/jwt-payload.type';

import { AgreementAcceptance } from '../entities/agreement-acceptance.entity';

/**
 * Lista las aceptaciones de acuerdos del usuario autenticado en su company.
 * Endpoint `GET /agreements/acceptances`. Read puro.
 */
@Injectable()
export class ListAcceptancesAction {
  constructor(
    @InjectRepository(AgreementAcceptance)
    private readonly repo: Repository<AgreementAcceptance>,
  ) {}

  async execute(companyId: number, user: AuthUser): Promise<AgreementAcceptance[]> {
    return this.repo.find({
      where: {
        company_id: String(companyId),
        user_id: String(user.user_id),
        account: user.account,
      },
      order: { agreement_key: 'ASC' },
    });
  }
}
