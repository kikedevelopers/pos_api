import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import type { Repository } from 'typeorm';

import type { AuthUser } from '@/common/types/jwt-payload.type';

import { AcceptAgreementDto } from '../dto/accept-agreement.dto';
import { AgreementAcceptance } from '../entities/agreement-acceptance.entity';

/**
 * Registra (o actualiza) la aceptación de un acuerdo por el usuario autenticado.
 * Endpoint `POST /agreements/accept`. Idempotente: si ya existe la aceptación
 * para `(company, user, account, key)` actualiza `version` + `accepted_at`.
 * El usuario/company salen del JWT (nunca del payload).
 */
@Injectable()
export class AcceptAgreementAction {
  constructor(
    @InjectRepository(AgreementAcceptance)
    private readonly repo: Repository<AgreementAcceptance>,
  ) {}

  async execute(
    dto: AcceptAgreementDto,
    companyId: number,
    user: AuthUser,
  ): Promise<AgreementAcceptance> {
    const where = {
      company_id: String(companyId),
      user_id: String(user.user_id),
      account: user.account,
      agreement_key: dto.key,
    };

    const existing = await this.repo.findOne({ where });
    if (existing) {
      existing.version = dto.version;
      existing.accepted_at = new Date();
      return this.repo.save(existing);
    }

    const created = this.repo.create({
      ...where,
      version: dto.version,
      accepted_at: new Date(),
    });
    return this.repo.save(created);
  }
}
