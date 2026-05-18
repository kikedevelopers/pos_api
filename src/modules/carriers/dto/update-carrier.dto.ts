import { PartialType } from '@nestjs/swagger';

import { CreateCarrierDto } from './create-carrier.dto';

/**
 * Payload de `PUT /carriers/:id`. Todos los campos opcionales.
 */
export class UpdateCarrierDto extends PartialType(CreateCarrierDto) {}
