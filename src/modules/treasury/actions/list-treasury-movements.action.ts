import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { FinancialMovement } from '@/modules/financial-movements/entities/financial-movement.entity';

import {
  TreasuryMovementResponseDto,
  toTreasuryMovementResponseDto,
} from '../dto/treasury-movement-response.dto';
import { buildNameResolver, type AccountNameRow } from '../internal/resolve-account-names';

/**
 * `GET /treasury/movements` — feed unificado de movimientos de TODAS las cuentas
 * de la company, ordenado por fecha DESC (más reciente primero). Sin filtro por
 * cuenta (a diferencia de `/financial-movements`): es la tabla `financial_movements`
 * completa del rango, con el nombre de cada cuenta origen/destino resuelto.
 *
 * Multi-tenancy: todas las queries filtran `company_id`. Los nombres se resuelven
 * en el backend (robusto incluso ante cuentas archivadas o borradas).
 */
@Injectable()
export class ListTreasuryMovementsAction {
  constructor(private readonly dataSource: DataSource) {}

  async execute(
    companyId: number,
    from?: string,
    to?: string,
  ): Promise<TreasuryMovementResponseDto[]> {
    const cid = String(companyId);

    const qb = this.dataSource
      .getRepository(FinancialMovement)
      .createQueryBuilder('m')
      .where('m.company_id = :companyId', { companyId: cid });

    // Filtro de rango opcional: el cliente envía instantes ISO (corte del día en
    // zona Colombia). Inclusivo en ambos extremos.
    if (from) qb.andWhere('m.created_at >= :from', { from: new Date(from) });
    if (to) qb.andWhere('m.created_at <= :to', { to: new Date(to) });
    qb.orderBy('m.created_at', 'DESC');

    // Movimientos + mapas de nombres (bancos/billeteras/cajas, incluidas
    // archivadas) en paralelo, todos scopeados por company.
    const [movements, bankRows, walletRows, registerRows] = await Promise.all([
      qb.getMany(),
      this.dataSource.query<AccountNameRow[]>(
        `SELECT id::int AS id, name FROM banks WHERE company_id = $1`,
        [cid],
      ),
      this.dataSource.query<AccountNameRow[]>(
        `SELECT id::int AS id, name FROM wallets WHERE company_id = $1`,
        [cid],
      ),
      this.dataSource.query<AccountNameRow[]>(
        `
        SELECT
          cr.id::int AS id,
          NULLIF(TRIM(BOTH FROM CONCAT_WS(' ', u.name, u.lastname)), '') AS name
        FROM cash_registers cr
        LEFT JOIN users u
          ON u.id = cr.user_id
         AND u.company_id = $1
        WHERE cr.company_id = $1
        `,
        [cid],
      ),
    ]);

    const resolve = buildNameResolver(bankRows, walletRows, registerRows);
    return movements.map((m) => toTreasuryMovementResponseDto(m, resolve));
  }
}
