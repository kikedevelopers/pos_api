import { Injectable } from '@nestjs/common';

import { GetCurrentCompanyAction } from './actions/get-current-company.action';
import { UpdateCompanyAction } from './actions/update-company.action';
import type { UpdateCompanyDto } from './dto/update-company.dto';
import type { Company } from './entities/company.entity';

/**
 * Facade del módulo `companies`. ZERO lógica — solo delega a las actions.
 */
@Injectable()
export class CompaniesService {
  constructor(
    private readonly getCurrentCompanyAction: GetCurrentCompanyAction,
    private readonly updateCompanyAction: UpdateCompanyAction,
  ) {}

  getCurrent(companyId: number): Promise<Company> {
    return this.getCurrentCompanyAction.execute(companyId);
  }

  update(companyId: number, dto: UpdateCompanyDto): Promise<Company> {
    return this.updateCompanyAction.execute(companyId, dto);
  }
}
