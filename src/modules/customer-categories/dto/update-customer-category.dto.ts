import { PartialType } from '@nestjs/swagger';

import { CreateCustomerCategoryDto } from './create-customer-category.dto';

/**
 * Payload de `PUT /customer-categories/:id`. `PartialType` hace `name`
 * opcional; un PUT con `{}` es no-op (mismo comportamiento que categorías de
 * producto).
 */
export class UpdateCustomerCategoryDto extends PartialType(CreateCustomerCategoryDto) {}
