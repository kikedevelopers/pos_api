import { Injectable } from '@nestjs/common';

import { GetCurrentCompanyAction } from './actions/get-current-company.action';
import {
  ListAllCompaniesAction,
  type ListAllCompaniesResult,
} from './actions/list-all-companies.action';
import { UpdateCompanyAction } from './actions/update-company.action';
import type { ListCompaniesQueryDto } from './dto/list-companies-query.dto';
import type { UpdateCompanyDto } from './dto/update-company.dto';
import type { Company } from './entities/company.entity';

export type { ListAllCompaniesResult } from './actions/list-all-companies.action';

/**
 * Facade del módulo `companies`. ZERO lógica — solo delega a las actions.
 */
@Injectable()
export class CompaniesService {
  constructor(
    private readonly getCurrentCompanyAction: GetCurrentCompanyAction,
    private readonly updateCompanyAction: UpdateCompanyAction,
    private readonly listAllCompaniesAction: ListAllCompaniesAction,
  ) {}

  getCurrent(companyId: number): Promise<Company> {
    return this.getCurrentCompanyAction.execute(companyId);
  }

  update(companyId: number, dto: UpdateCompanyDto): Promise<Company> {
    return this.updateCompanyAction.execute(companyId, dto);
  }

  listAll(query: ListCompaniesQueryDto): Promise<ListAllCompaniesResult> {
    return this.listAllCompaniesAction.execute(query);
  }
}
