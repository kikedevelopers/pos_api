import { PartialType } from '@nestjs/swagger';

import { CreateRestaurantTableDto } from './create-restaurant-table.dto';

/** Payload de `PUT /restaurant-tables/:id`. Edita nombre y/o nº de sillas. */
export class UpdateRestaurantTableDto extends PartialType(CreateRestaurantTableDto) {}
