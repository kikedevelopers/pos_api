import { PartialType } from '@nestjs/swagger';

import { CreateSalonDto } from './create-salon.dto';

/** Payload de `PUT /salons/:id`. Solo el nombre es editable. */
export class UpdateSalonDto extends PartialType(CreateSalonDto) {}
