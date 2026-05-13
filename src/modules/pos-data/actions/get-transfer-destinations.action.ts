import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { Bank } from '@/modules/banks/entities/bank.entity';
import { Wallet } from '@/modules/wallets/entities/wallet.entity';

/**
 * Item de destino dentro del payload de `GET /pos-data/transfer-destinations`.
 */
export interface PosDataDestinationItem {
  id: number;
  name: string;
  balance: number;
  type: 'user' | 'wallet' | 'bank';
}

/**
 * Payload de `GET /pos-data/transfer-destinations`. Mantiene el shape
 * agrupado `{ users, wallets, banks }` que PlacePos devuelve para que el
 * frontend POS no requiera cambios al construir el modal de traslado.
 *
 * Cloud divergence: `users: []` siempre vacío — el modelo de caja en cloud
 * es por turno de company, no por usuario, así que no hay destinatarios
 * tipo `user` listables. El frontend debe ocultar la opción cuando el array
 * llega vacío.
 */
export interface PosDataDestinationsPayload {
  destinations: {
    users: PosDataDestinationItem[];
    wallets: PosDataDestinationItem[];
    banks: PosDataDestinationItem[];
  };
}

/**
 * `GET /pos-data/transfer-destinations`. Lista las cuentas destino
 * disponibles para mover efectivo desde la caja abierta del POS.
 *
 * Diferencias respecto a `accounts/transfer-destinations`:
 *   - No requiere `sourceType`/`sourceId` (la fuente es implícita: la caja
 *     abierta de la company).
 *   - Devuelve los destinos agrupados por tipo (no plano) para paridad con
 *     el frontend POS de PlacePos.
 *   - `users: []` siempre vacío (cloud no tiene caja personal por usuario).
 *
 * Multi-tenancy: `where: { company_id, is_archived: false }`.
 */
@Injectable()
export class GetPosTransferDestinationsAction {
  constructor(
    @InjectRepository(Wallet)
    private readonly walletRepo: Repository<Wallet>,
    @InjectRepository(Bank)
    private readonly bankRepo: Repository<Bank>,
  ) {}

  async execute(companyId: number): Promise<PosDataDestinationsPayload> {
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

    return {
      destinations: {
        users: [],
        wallets: wallets.map((w) => ({
          id: Number(w.id),
          name: w.name,
          balance: Number(w.balance),
          type: 'wallet',
        })),
        banks: banks.map((b) => ({
          id: Number(b.id),
          name: b.name,
          balance: Number(b.balance),
          type: 'bank',
        })),
      },
    };
  }
}
