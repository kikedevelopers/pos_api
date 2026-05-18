import { PartialType } from '@nestjs/swagger';

import { CreateCategoryDto } from './create-category.dto';

/**
 * Payload de `PUT /categories/:id`. `PartialType` hace `name` opcional;
 * un PUT con `{}` es no-op (espejo PlacePos).
 */
export class UpdateCategoryDto extends PartialType(CreateCategoryDto) {}
