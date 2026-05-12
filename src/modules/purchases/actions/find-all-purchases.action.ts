import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import type { Repository } from 'typeorm';

import { PurchaseCredit } from '../entities/purchase-credit.entity';
import { Purchase } from '../entities/purchase.entity';

/**
 * Tupla parcial que devuelve el listado: cabecera de la compra + su credit
 * asociado (sin líneas ni pagos — paridad PlacePos `GET /purchases`).
 *
 * El frontend cloud no necesita las líneas en el listado para evitar payloads
 * gigantes; cuando el usuario abre el detalle pide `GET /purchases/:id`.
 */
export interface PurchaseListItem {
  purchase: Purchase;
  credit: PurchaseCredit | null;
}

/**
 * Lista compras de una company:
 *
 *   - Por defecto: solo las que tienen `PurchaseCredit.balance > 0`. Espejo
 *     PlacePos del feed "pendientes de pago".
 *   - `showAll = true`: todas las no anuladas (orden por `created_at DESC`).
 *
 * Multi-tenancy: filtro estricto por `p.company_id` Y `pc.company_id` (defensa
 * cross-join — aunque la FK garantiza coherencia, el predicado explícito
 * previene fugas si en el futuro cambia el modelo).
 *
 * Read puro — no requiere transacción.
 *
 * Costo de la query: el índice parcial
 * `idx_purchases_company_active_created` cubre el filtro + orden; el LEFT
 * JOIN contra `purchase_credits` por (company_id, purchase_id) usa el
 * UNIQUE index (`idx_purchase_credits_company_purchase_unique`).
 */
@Injectable()
export class FindAllPurchasesAction {
  constructor(
    @InjectRepository(Purchase)
    private readonly repo: Repository<Purchase>,
  ) {}

  async execute(companyId: number, showAll = false): Promise<PurchaseListItem[]> {
    const qb = this.repo
      .createQueryBuilder('p')
      .leftJoinAndMapOne(
        'p.credit',
        PurchaseCredit,
        'pc',
        'pc.purchase_id = p.id AND pc.company_id = p.company_id',
      )
      .where('p.company_id = :companyId', { companyId: String(companyId) })
      .andWhere('p.is_deleted = false')
      .orderBy('p.created_at', 'DESC');

    if (!showAll) {
      qb.andWhere('pc.id IS NOT NULL').andWhere('pc.balance > 0');
    }

    const rows = await qb.getMany();

    return rows.map((row) => {
      // `leftJoinAndMapOne` cuelga el credit como propiedad opcional.
      const credit = (row as Purchase & { credit?: PurchaseCredit | null }).credit ?? null;
      return { purchase: row, credit };
    });
  }
}
