import { Injectable } from '@nestjs/common';

import {
  ApplyWalletAdjustmentAction,
  type WalletAdjustmentActor,
  type WalletAdjustmentResult,
} from './actions/apply-wallet-adjustment.action';
import { ArchiveWalletAction } from './actions/archive-wallet.action';
import { CreateWalletAction, type WalletCreator } from './actions/create-wallet.action';
import { FindAllWalletsAction } from './actions/find-all-wallets.action';
import { UpdateWalletAction } from './actions/update-wallet.action';
import type { CreateWalletAdjustmentDto } from './dto/create-wallet-adjustment.dto';
import type { CreateWalletDto } from './dto/create-wallet.dto';
import type { UpdateWalletDto } from './dto/update-wallet.dto';
import type { Wallet } from './entities/wallet.entity';

export type { WalletCreator } from './actions/create-wallet.action';
export type {
  WalletAdjustmentActor,
  WalletAdjustmentResult,
} from './actions/apply-wallet-adjustment.action';

/**
 * Facade del módulo `wallets`. ZERO lógica — solo delega.
 *
 * El action `CreateDefaultWalletAction` NO se expone en el service (no es
 * un endpoint público). Se exporta directamente desde el módulo para que
 * `RegisterAction` lo inyecte en su transacción.
 */
@Injectable()
export class WalletsService {
  constructor(
    private readonly findAllWalletsAction: FindAllWalletsAction,
    private readonly createWalletAction: CreateWalletAction,
    private readonly updateWalletAction: UpdateWalletAction,
    private readonly archiveWalletAction: ArchiveWalletAction,
    private readonly applyWalletAdjustmentAction: ApplyWalletAdjustmentAction,
  ) {}

  findAll(companyId: number): Promise<Wallet[]> {
    return this.findAllWalletsAction.execute(companyId);
  }

  create(dto: CreateWalletDto, companyId: number, createdBy: WalletCreator): Promise<Wallet> {
    return this.createWalletAction.execute(dto, companyId, createdBy);
  }

  update(id: number, dto: UpdateWalletDto, companyId: number): Promise<Wallet> {
    return this.updateWalletAction.execute(id, dto, companyId);
  }

  archive(id: number, companyId: number, actorId: number): Promise<void> {
    return this.archiveWalletAction.execute(id, companyId, actorId);
  }

  applyAdjustment(
    walletId: number,
    dto: CreateWalletAdjustmentDto,
    companyId: number,
    actor: WalletAdjustmentActor,
  ): Promise<WalletAdjustmentResult> {
    return this.applyWalletAdjustmentAction.execute(walletId, dto, companyId, actor);
  }
}
