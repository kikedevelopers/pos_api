import {
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { DataSource } from 'typeorm';

import { toBig } from '@/common/utils/precision';

import { Carrier } from '../entities/carrier.entity';
import { CarrierCredit } from '../entities/carrier-credit.entity';
import { findCarrierInCompany } from '../internal/carrier-lookups';

/**
 * Archiva un carrier (`PUT /carriers/:id/archive`).
 *
 *   - 404 si no existe o pertenece a otra company.
 *   - 404 si ya está archivado (espejo PlacePos).
 *   - 422 si tiene algún `CarrierCredit` con `balance > 0` (deuda pendiente).
 *   - 200 con `{ archived: true }` al éxito.
 */
@Injectable()
export class ArchiveCarrierAction {
  private readonly logger = new Logger(ArchiveCarrierAction.name);

  constructor(private readonly dataSource: DataSource) {}

  async execute(id: number, companyId: number): Promise<{ archived: true }> {
    await this.dataSource.transaction(async (manager) => {
      const existing = await findCarrierInCompany(manager, id, companyId);

      if (existing.is_archived) {
        throw new NotFoundException('Transportista no encontrado');
      }

      // 422 si tiene deuda pendiente. Iteramos sobre los créditos para que el
      // mensaje pueda detallar cuánto debe (mejor UX).
      const pendingCredits = await manager.find(CarrierCredit, {
        where: { company_id: String(companyId), carrier_id: String(id) },
      });
      const totalPending = pendingCredits.reduce((acc, c) => acc.plus(toBig(c.balance)), toBig(0));
      if (totalPending.gt(0)) {
        throw new UnprocessableEntityException(
          `No se puede archivar el transportista: tiene deuda pendiente de ${totalPending.toFixed(2)}`,
        );
      }

      await manager.update(
        Carrier,
        { id: String(id), company_id: String(companyId) },
        { is_archived: true },
      );
    });

    this.logger.log({
      event: 'carrier.archived',
      companyId,
      carrierId: id,
    });

    return { archived: true };
  }
}
