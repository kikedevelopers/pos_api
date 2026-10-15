import { ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { IsBoolean, IsOptional } from 'class-validator';

import { CreateCategoryDto } from './create-category.dto';

/**
 * Payload de `PUT /categories/:id`. `PartialType` hace `name` opcional;
 * un PUT con `{}` es no-op (espejo PlacePos).
 */
export class UpdateCategoryDto extends PartialType(CreateCategoryDto) {
  @ApiPropertyOptional({
    example: false,
    description: 'Visibilidad de la categoría completa en el catálogo público.',
  })
  @IsOptional()
  @IsBoolean()
  catalog_visible?: boolean;
}
