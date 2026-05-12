import { Injectable } from '@nestjs/common';

import { ArchiveBankAction } from './actions/archive-bank.action';
import { CreateBankAction, type BankCreator } from './actions/create-bank.action';
import { FindAllBanksAction } from './actions/find-all-banks.action';
import { UpdateBankAction } from './actions/update-bank.action';
import type { CreateBankDto } from './dto/create-bank.dto';
import type { UpdateBankDto } from './dto/update-bank.dto';
import type { Bank } from './entities/bank.entity';

export type { BankCreator } from './actions/create-bank.action';

/**
 * Facade del módulo `banks`. ZERO lógica — solo delega a las actions.
 */
@Injectable()
export class BanksService {
  constructor(
    private readonly findAllBanksAction: FindAllBanksAction,
    private readonly createBankAction: CreateBankAction,
    private readonly updateBankAction: UpdateBankAction,
    private readonly archiveBankAction: ArchiveBankAction,
  ) {}

  findAll(companyId: number): Promise<Bank[]> {
    return this.findAllBanksAction.execute(companyId);
  }

  create(dto: CreateBankDto, companyId: number, createdBy: BankCreator): Promise<Bank> {
    return this.createBankAction.execute(dto, companyId, createdBy);
  }

  update(id: number, dto: UpdateBankDto, companyId: number): Promise<Bank> {
    return this.updateBankAction.execute(id, dto, companyId);
  }

  archive(id: number, companyId: number, actorId: number): Promise<void> {
    return this.archiveBankAction.execute(id, companyId, actorId);
  }
}
