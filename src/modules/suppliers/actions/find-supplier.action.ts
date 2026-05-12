import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import type { Repository } from 'typeorm';

import { Supplier } from '@/modules/suppliers/entities/supplier.entity';

import { findSupplierInCompany } from '../internal/supplier-lookups';

/**
 * Lectura por id (`GET /suppliers/:id`).
 *
 * NOTA: PlacePos filtra adicionalmente `is_archived = false` en este endpoint
 * (un supplier archivado responde 404). Espejamos ese comportamiento exacto
 * para mantener paridad byte-por-byte. Si se necesita consultar archivados
 * por id, se hace vía `?include_archived=true` en el listado o por reportes
 * dedicados (Fase 7+).
 *
 * El mensaje 404 es idéntico al del lookup ("Proveedor no encontrado") para
 * no distinguir "archivado" de "inexistente" — anti-enumeración.
 */
@Injectable()
export class FindSupplierAction {
  constructor(
    @InjectRepository(Supplier)
    private readonly repo: Repository<Supplier>,
  ) {}

  async execute(id: number, companyId: number): Promise<Supplier> {
    const supplier = await findSupplierInCompany(this.repo.manager, id, companyId);
    if (supplier.is_archived) {
      throw new NotFoundException('Proveedor no encontrado');
    }
    return supplier;
  }
}
