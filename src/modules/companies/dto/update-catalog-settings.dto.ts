import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsOptional, IsString, ValidateIf } from 'class-validator';

/**
 * Payload de `PATCH /companies/catalog` — configuración del catálogo público
 * desde Configuraciones → Catálogo (placepos).
 *
 * Update parcial: solo se tocan los campos presentes.
 *   - `slug`: texto libre que el service NORMALIZA ("Esencia y Grano" →
 *     "esenciaygrano"). `null`/'' borra el slug (solo si el catálogo queda
 *     deshabilitado). El formato lo valida el service con `validateSlug`, no
 *     class-validator, para poder normalizar y devolver el slug limpio.
 *   - `catalog_enabled`: interruptor de publicación. Habilitar exige un slug.
 */
export class UpdateCatalogSettingsDto {
  @ApiPropertyOptional({ example: 'esenciaygrano', nullable: true })
  @IsOptional()
  @ValidateIf((o: UpdateCatalogSettingsDto) => o.slug !== null)
  @IsString({ message: 'slug debe ser un texto' })
  slug?: string | null;

  @ApiPropertyOptional({ example: true })
  @IsOptional()
  @IsBoolean({ message: 'catalog_enabled debe ser verdadero o falso' })
  catalog_enabled?: boolean;

  @ApiPropertyOptional({ example: false })
  @IsOptional()
  @IsBoolean({ message: 'catalog_group_by_category debe ser verdadero o falso' })
  catalog_group_by_category?: boolean;
}
