import { Injectable } from '@nestjs/common';

import {
  GetTransferDestinationsAction,
  type TransferDestinationItem,
} from './actions/get-transfer-destinations.action';
import { TransferAction, type TransferActor, type TransferResult } from './actions/transfer.action';
import type { TransferAccountType } from './dto/transfer.dto';
import type { TransferDto } from './dto/transfer.dto';

export type { TransferActor, TransferResult } from './actions/transfer.action';
export type { TransferDestinationItem } from './actions/get-transfer-destinations.action';

/**
 * Facade del módulo agregador `accounts`. Sin lógica.
 */
@Injectable()
export class AccountsService {
  constructor(
    private readonly getTransferDestinationsAction: GetTransferDestinationsAction,
    private readonly transferAction: TransferAction,
  ) {}

  getTransferDestinations(
    companyId: number,
    sourceType: TransferAccountType,
    sourceId: number,
  ): Promise<{ destinations: TransferDestinationItem[] }> {
    return this.getTransferDestinationsAction.execute(companyId, sourceType, sourceId);
  }

  transfer(dto: TransferDto, companyId: number, actor: TransferActor): Promise<TransferResult> {
    return this.transferAction.execute(dto, companyId, actor);
  }
}
