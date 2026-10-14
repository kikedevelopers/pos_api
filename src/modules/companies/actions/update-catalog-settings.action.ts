import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { DataSource, Not } from 'typeorm';

import { slugRejectionMessage, validateSlug } from '@/modules/catalog/internal/catalog-slug';

import type { UpdateCatalogSettingsDto } from '../dto/update-catalog-settings.dto';
import { Company } from '../entities/company.entity';

/**
 * Configura el catálogo público de la company: su slug y el gate de publicación.
 *
 * Reglas:
 *   - `slug` llega como texto libre y se NORMALIZA (`validateSlug`). Un slug
 *     inválido (vacío tras normalizar, muy corto/largo) → 400.
 *   - El slug es UNIQUE global: si otra company ya lo usa → 409 (y un 23505 de
 *     carrera se traduce al mismo 409).
 *   - Borrar el slug (`null`/'') solo se permite si el catálogo queda apagado.
 *   - Habilitar el catálogo exige tener slug (el del DTO o el ya guardado) → si
 *     no, 400.
 *
 * Toda mutación en transacción (§8.8), aunque sea un paso.
 */
@Injectable()
export class UpdateCatalogSettingsAction {
  constructor(private readonly dataSource: DataSource) {}

  async execute(companyId: number, dto: UpdateCatalogSettingsDto): Promise<Company> {
    return this.dataSource.transaction<Company>(async (manager) => {
      const company = await manager.findOne(Company, { where: { id: String(companyId) } });
      if (!company) {
        throw new NotFoundException('No se encontró información de la empresa');
      }

      const updatePayload: Partial<Company> = {};

      // 1. Resolver el slug objetivo (si el DTO lo trae).
      let nextSlug = company.catalog_slug;
      if (dto.slug !== undefined) {
        const raw = dto.slug ?? '';
        if (raw.trim() === '') {
          // Intención de borrar el slug.
          nextSlug = null;
          updatePayload.catalog_slug = null;
        } else {
          const result = validateSlug(raw);
          if (!result.ok) {
            throw new BadRequestException(slugRejectionMessage(result.reason));
          }
          // UNIQUE global: que no lo tenga OTRA company.
          const taken = await manager.findOne(Company, {
            where: { catalog_slug: result.slug, id: Not(String(companyId)) },
            select: { id: true },
          });
          if (taken) {
            throw new ConflictException(
              'Ese nombre de catálogo ya está en uso por otro negocio. Elige otro.',
            );
          }
          nextSlug = result.slug;
          updatePayload.catalog_slug = result.slug;
        }
      }

      // 2. Resolver el gate.
      const nextEnabled = dto.catalog_enabled ?? company.catalog_enabled;
      if (dto.catalog_enabled !== undefined) {
        updatePayload.catalog_enabled = dto.catalog_enabled;
      }

      // 2b. Preferencia de presentación (agrupar por categoría). Sin invariante:
      // es solo cómo se pinta el catálogo.
      if (dto.catalog_group_by_category !== undefined) {
        updatePayload.catalog_group_by_category = dto.catalog_group_by_category;
      }

      // 3. Invariantes cruzadas.
      if (nextEnabled && !nextSlug) {
        throw new BadRequestException(
          'Define primero el nombre del catálogo antes de habilitarlo.',
        );
      }

      if (Object.keys(updatePayload).length > 0) {
        try {
          await manager.update(Company, { id: String(companyId) }, updatePayload);
        } catch (error) {
          // Carrera: dos negocios guardaron el mismo slug a la vez. El índice
          // único parcial lanza 23505; lo traducimos al mismo 409 amable.
          if (isUniqueViolation(error)) {
            throw new ConflictException(
              'Ese nombre de catálogo ya está en uso por otro negocio. Elige otro.',
            );
          }
          throw error;
        }
      }

      const updated = await manager.findOne(Company, { where: { id: String(companyId) } });
      if (!updated) {
        throw new NotFoundException('No se encontró información de la empresa');
      }
      return updated;
    });
  }
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: string }).code === '23505'
  );
}
