import { Injectable } from '@nestjs/common';
import type { EntityManager } from 'typeorm';

import { Wallet } from '../entities/wallet.entity';

/**
 * Crea la wallet "Efectivo" inicial de una company recién registrada.
 *
 * Espejo del seed `seedEssentials` de PlacePos:
 *   `Wallet { name: 'Efectivo', balance: 0 }`.
 *
 * Diseñado para ser invocado DENTRO de la transacción del
 * `RegisterAction` — exige el `manager` para forzar atomicidad. Si el
 * register falla por cualquier paso, la wallet se revierte junto con
 * Company + User.
 *
 * Cómo cablearlo (instrucciones para el integrador):
 *
 *   1. Importar `CreateDefaultWalletAction` en
 *      `src/modules/auth/auth.module.ts` (vía
 *      `WalletsModule.forFeature` o re-import directo desde `WalletsModule`,
 *      que ya lo exporta).
 *
 *   2. Inyectarlo en `RegisterAction`:
 *        constructor(
 *          private readonly dataSource: DataSource,
 *          private readonly jwtIssuer: JwtIssuerService,
 *          private readonly createDefaultWalletAction: CreateDefaultWalletAction,
 *        ) {}
 *
 *   3. Después de `manager.save(User, user)`, antes del `return saved`,
 *      añadir:
 *        await this.createDefaultWalletAction.execute(manager, {
 *          companyId: Number(savedCompany.id),
 *          createdBy: {
 *            id: Number(saved.id),
 *            fullName: `${saved.name} ${saved.lastname}`.trim(),
 *          },
 *        });
 *
 *   4. Importar `WalletsModule` desde `AuthModule.imports` para que la
 *      inyección resuelva.
 */
export interface CreateDefaultWalletInput {
  companyId: number;
  createdBy: { id: number; fullName: string };
  /**
   * Por defecto "Efectivo" (espejo de PlacePos). Override solo para tests
   * que necesiten un nombre distinto.
   */
  name?: string;
}

@Injectable()
export class CreateDefaultWalletAction {
  async execute(manager: EntityManager, input: CreateDefaultWalletInput): Promise<Wallet> {
    const repo = manager.getRepository(Wallet);

    const wallet = repo.create({
      company_id: String(input.companyId),
      name: input.name ?? 'Efectivo',
      balance: 0,
      is_archived: false,
      created_by: input.createdBy.fullName,
      created_by_id: String(input.createdBy.id),
    });

    return repo.save(wallet);
  }
}
