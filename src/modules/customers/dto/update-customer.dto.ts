import { PartialType } from '@nestjs/swagger';

import { CreateCustomerDto } from './create-customer.dto';

/**
 * Payload de `PUT /customers/:id`.
 *
 * `PartialType` hace TODOS los campos del `CreateCustomerDto` opcionales, lo
 * que respeta la semántica de PlacePos: un PUT con `{}` se trata como no-op.
 *
 * Los campos prohibidos (`company_id`, `balance`, `created_by*`, `is_archived`)
 * heredan la exclusión del create — el ValidationPipe los strippea con
 * `whitelist: true`. La mutación de `balance` queda reservada a fases 6/8/9;
 * la de `is_archived` al endpoint `PUT /:id/archive`.
 */
export class UpdateCustomerDto extends PartialType(CreateCustomerDto) {}
