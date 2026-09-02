import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { Company } from '@/modules/companies/entities/company.entity';
import { ProductImagesService } from '@/modules/product-images/product-images.service';

/**
 * Borra una company COMPLETA (y todo su tenant por cascada) desde el panel
 * superadmin. IRREVERSIBLE: la migración `EnableTenantCascadeDelete` hace que
 * `DELETE FROM companies WHERE id = ...` arrastre ventas, compras, usuarios,
 * suscripción, etc.
 *
 * Se ejecuta en transacción: verifica la existencia y borra atómicamente. Si la
 * company no existe, 404 (no se abre el camino destructivo).
 *
 * SUCURSALES. Borrar el NEGOCIO PRINCIPAL arrastra también sus sucursales. La
 * cascada de la BD no basta: las sucursales son companies propias, y lo único
 * que las ata al principal es `company_members`, que cuelga del `user` (owner).
 * Al borrar el principal, el owner se va con él y las membresías caen por
 * cascada — pero las companies de las sucursales SOBREVIVIRÍAN, ya sin dueño ni
 * forma de alcanzarlas: basura invisible con todos los datos del cliente
 * dentro. Se resuelven ANTES de borrar y se eliminan en la MISMA transacción.
 *
 * Borrar una sucursal, en cambio, no toca al principal: solo se va ella.
 *
 * IMÁGENES. La cascada de la BD no llega al bucket: las fotos del inventario
 * viven en Google Cloud Storage y su única referencia eran las filas que se
 * acaban de borrar. Se eliminan por carpeta DESPUÉS del commit (si la
 * transacción se revirtiera, los archivos ya no estarían) y sin bloquear el
 * resultado: el tenant ya se fue y un fallo del bucket no puede deshacerlo.
 */
@Injectable()
export class DeleteTenantAction {
  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
    private readonly productImages: ProductImagesService,
  ) {}

  async execute(companyId: number): Promise<void> {
    const deletedCompanyIds = await this.dataSource.transaction<string[]>(async (manager) => {
      const companyRepo = manager.getRepository(Company);
      const company = await companyRepo.findOne({ where: { id: String(companyId) } });
      if (!company) {
        throw new NotFoundException(`Company ${companyId} no existe.`);
      }

      // Sucursales del owner de esta company (solo si es el negocio principal).
      const ids = [String(companyId)];
      if (!company.is_branch) {
        const rows = await manager.query<Array<{ id: string }>>(
          `SELECT c.id::text AS id
           FROM company_members cm
           JOIN companies c ON c.id = cm.company_id
           JOIN users u ON u.id = cm.user_id
           WHERE u.company_id = $1 AND c.is_branch = true`,
          [companyId],
        );
        ids.push(...rows.map((r) => r.id));
      }

      // El DELETE de cada fila de companies dispara la cascada total en DB.
      await companyRepo.delete(ids);
      return ids;
    });

    // Fuera de la transacción: las imágenes de cada company borrada (principal
    // y sucursales) ya no tienen quien las referencie.
    for (const id of deletedCompanyIds) {
      await this.productImages.removeAllForCompany(Number(id));
    }
  }
}
