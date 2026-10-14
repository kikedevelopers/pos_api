import { Injectable } from '@nestjs/common';
import { DataSource, Not } from 'typeorm';

import { normalizeSlug, validateSlug } from '@/modules/catalog/internal/catalog-slug';

import { Company } from '../entities/company.entity';

/** Resultado de comprobar un slug candidato antes de guardarlo. */
export interface SlugAvailability {
  /** El slug ya normalizado (lo que de verdad se guardaría). */
  slug: string;
  /** ¿Cumple el formato (longitud/caracteres)? */
  valid: boolean;
  /** ¿Está libre (ninguna OTRA company lo usa)? Solo relevante si `valid`. */
  available: boolean;
  /** Mensaje de por qué no sirve, si aplica. */
  reason?: string;
}

/**
 * Comprueba la disponibilidad de un slug de catálogo para la UI (debounced
 * mientras el dueño escribe). Normaliza, valida el formato y verifica que no lo
 * tenga OTRA company (el propio no cuenta: re-guardar el mismo slug es válido).
 *
 * Read puro. No es la autoridad final: `UpdateCatalogSettingsAction` revalida y
 * el índice único de la DB es el árbitro ante una carrera.
 */
@Injectable()
export class CheckCatalogSlugAction {
  constructor(private readonly dataSource: DataSource) {}

  async execute(companyId: number, raw: string): Promise<SlugAvailability> {
    const result = validateSlug(raw ?? '');
    if (!result.ok) {
      return {
        slug: normalizeSlug(raw ?? ''),
        valid: false,
        available: false,
        reason:
          result.reason === 'too_long'
            ? 'Demasiado largo.'
            : result.reason === 'too_short'
              ? 'Demasiado corto.'
              : 'Usa solo letras y números, sin espacios ni símbolos.',
      };
    }

    const taken = await this.dataSource.manager.findOne(Company, {
      where: { catalog_slug: result.slug, id: Not(String(companyId)) },
      select: { id: true },
    });

    return {
      slug: result.slug,
      valid: true,
      available: !taken,
      reason: taken ? 'Ese nombre ya está en uso.' : undefined,
    };
  }
}
