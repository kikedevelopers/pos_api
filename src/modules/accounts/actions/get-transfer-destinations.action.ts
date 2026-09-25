import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';

import { Bank } from '@/modules/banks/entities/bank.entity';
import { CashRegister } from '@/modules/cash-register/entities/cash-register.entity';
import { User, UserType } from '@/modules/users/entities/user.entity';
import { Wallet } from '@/modules/wallets/entities/wallet.entity';

import type { TransferAccountType } from '../dto/transfer.dto';
import { getCompanyRef, resolveMainCompanyForBranch } from '../internal/resolve-main-company';

/**
 * Alcance de un destino: `'self'` = cuenta de la misma company; `'main'` =
 * cuenta del NEGOCIO PRINCIPAL (solo aparece cuando la company del JWT es una
 * sucursal). El frontend usa este campo para agrupar los destinos "main" bajo
 * una sección "Negocio Principal".
 */
export type TransferDestinationScopeOut = 'self' | 'main';

/**
 * Item de destino disponible para una transferencia. Discriminado por `type`.
 *
 * `scope`/`company_name` se añaden para el flujo multi-sucursal: los destinos
 * del negocio principal llegan con `scope='main'` y el nombre del principal en
 * `company_name`. Los destinos propios siempre traen `scope='self'` y
 * `company_name` ausente (paridad de payload para clientes que solo miran los
 * campos históricos).
 */
export interface TransferDestinationItem {
  id: number;
  name: string;
  balance: number;
  type: 'bank' | 'wallet' | 'user';
  scope: TransferDestinationScopeOut;
  company_name?: string;
}

/**
 * Construye la lista de cuentas destino disponibles cuando se especifica
 * una fuente. Espeja `accounts.routes.ts` de PlacePos y añade la sección
 * multi-sucursal:
 *
 *   - Si source = wallet → destinos: otras wallets + bancos + usuarios con
 *     caja registradora (`cash_register`) en la misma company.
 *   - Si source = bank → destinos: otros bancos + wallets.
 *   - Si la company del JWT es una SUCURSAL → se agregan, al final, los
 *     `wallet`/`bank` ACTIVOS del NEGOCIO PRINCIPAL con `scope='main'`
 *     (nunca cajas de usuario cross-company).
 *
 * Multi-tenant: los destinos propios se filtran por la `companyId` del JWT;
 * los del principal por el id del principal resuelto vía `company_members`
 * (`resolveMainCompanyForBranch`), independientemente del usuario logueado.
 */
@Injectable()
export class GetTransferDestinationsAction {
  constructor(
    @InjectRepository(Wallet)
    private readonly walletRepo: Repository<Wallet>,
    @InjectRepository(Bank)
    private readonly bankRepo: Repository<Bank>,
    @InjectRepository(User)
    private readonly userRepo: Repository<User>,
    private readonly dataSource: DataSource,
  ) {}

  async execute(
    companyId: number,
    sourceType: TransferAccountType,
    sourceId: number,
  ): Promise<{ destinations: TransferDestinationItem[] }> {
    const wallets = await this.walletRepo.find({
      where: { company_id: String(companyId), is_archived: false },
      select: { id: true, name: true, balance: true },
      order: { name: 'ASC' },
    });
    const banks = await this.bankRepo.find({
      where: { company_id: String(companyId), is_archived: false },
      select: { id: true, name: true, balance: true },
      order: { name: 'ASC' },
    });

    const destinations: TransferDestinationItem[] = [];

    if (sourceType === 'wallet') {
      for (const w of wallets) {
        if (Number(w.id) === sourceId) {
          continue;
        }
        destinations.push({
          id: Number(w.id),
          name: w.name,
          balance: Number(w.balance),
          type: 'wallet',
          scope: 'self',
        });
      }
      for (const b of banks) {
        destinations.push({
          id: Number(b.id),
          name: b.name,
          balance: Number(b.balance),
          type: 'bank',
          scope: 'self',
        });
      }

      // Solo se listan usuarios con caja registrada (modelo PlacePos: el
      // INNER JOIN garantiza que la caja existe; el balance mostrado es el
      // de la caja, no el `balance` personal del User). Cualquier user-type
      // dentro de la company es candidato (owner + employees con login
      // habilitado han creado fila espejo en `users`).
      const usersWithRegister = await this.userRepo
        .createQueryBuilder('u')
        .innerJoin(CashRegister, 'cr', 'cr.user_id = u.id AND cr.company_id = u.company_id')
        .where('u.company_id = :companyId', { companyId: String(companyId) })
        .andWhere('u.type != :superadmin', { superadmin: UserType.SUPERADMIN })
        .select(['u.id AS id', 'u.name AS name', 'u.lastname AS lastname', 'cr.balance AS balance'])
        .orderBy('u.name', 'ASC')
        .getRawMany<{ id: string; name: string; lastname: string; balance: string | number }>();

      for (const u of usersWithRegister) {
        destinations.push({
          id: Number(u.id),
          name: `${u.name ?? ''} ${u.lastname ?? ''}`.trim() || 'Usuario',
          balance: Number(u.balance),
          type: 'user',
          scope: 'self',
        });
      }
    } else {
      for (const b of banks) {
        if (Number(b.id) === sourceId) {
          continue;
        }
        destinations.push({
          id: Number(b.id),
          name: b.name,
          balance: Number(b.balance),
          type: 'bank',
          scope: 'self',
        });
      }
      for (const w of wallets) {
        destinations.push({
          id: Number(w.id),
          name: w.name,
          balance: Number(w.balance),
          type: 'wallet',
          scope: 'self',
        });
      }
    }

    // Sección "Negocio Principal": solo cuando la company del JWT es una
    // sucursal. El dinero fluye SUCURSAL → PRINCIPAL, nunca a otras sucursales.
    const mainDestinations = await this.buildMainDestinations(companyId);
    destinations.push(...mainDestinations);

    return { destinations };
  }

  /**
   * Devuelve las cuentas `wallet`/`bank` activas del negocio principal cuando
   * la company `companyId` es una sucursal. Lista vacía en caso contrario
   * (company principal, sin membresía resoluble, o sin principal).
   */
  private async buildMainDestinations(companyId: number): Promise<TransferDestinationItem[]> {
    const current = await getCompanyRef(this.dataSource, companyId);
    if (!current || !current.is_branch) {
      return [];
    }

    const main = await resolveMainCompanyForBranch(this.dataSource, companyId);
    if (!main) {
      return [];
    }

    const [mainWallets, mainBanks] = await Promise.all([
      this.walletRepo.find({
        where: { company_id: String(main.id), is_archived: false },
        select: { id: true, name: true, balance: true },
        order: { name: 'ASC' },
      }),
      this.bankRepo.find({
        where: { company_id: String(main.id), is_archived: false },
        select: { id: true, name: true, balance: true },
        order: { name: 'ASC' },
      }),
    ]);

    const items: TransferDestinationItem[] = [];
    for (const w of mainWallets) {
      items.push({
        id: Number(w.id),
        name: w.name,
        balance: Number(w.balance),
        type: 'wallet',
        scope: 'main',
        company_name: main.name,
      });
    }
    for (const b of mainBanks) {
      items.push({
        id: Number(b.id),
        name: b.name,
        balance: Number(b.balance),
        type: 'bank',
        scope: 'main',
        company_name: main.name,
      });
    }
    return items;
  }
}
