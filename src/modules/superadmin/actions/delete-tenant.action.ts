import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { Company } from '@/modules/companies/entities/company.entity';

/**
 * Borra una company COMPLETA (y todo su tenant por cascada) desde el panel
 * superadmin. IRREVERSIBLE: la migración `EnableTenantCascadeDelete` hace que
 * `DELETE FROM companies WHERE id = ...` arrastre ventas, compras, usuarios,
 * suscripción, etc.
 *
 * Se ejecuta en transacción: verifica la existencia y borra atómicamente. Si la
 * company no existe, 404 (no se abre el camino destructivo).
 */
@Injectable()
export class DeleteTenantAction {
  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  async execute(companyId: number): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      const companyRepo = manager.getRepository(Company);
      const company = await companyRepo.findOne({ where: { id: String(companyId) } });
      if (!company) {
        throw new NotFoundException(`Company ${companyId} no existe.`);
      }
      // El DELETE de la fila companies dispara la cascada total en DB.
      await companyRepo.delete({ id: String(companyId) });
    });
  }
}
