import { PartialType } from '@nestjs/swagger';

import { CreateSupplierDto } from './create-supplier.dto';

/**
 * Payload de `PUT /suppliers/:id`.
 *
 * `PartialType` hace todos los campos del create opcionales. PUT con `{}` es
 * un no-op (paridad PlacePos).
 *
 * `accumulated_debt`, `credit_balance` y `is_archived` heredan la exclusión
 * del create — reservados a sus respectivos flujos (purchases/payments y
 * endpoint archive).
 */
export class UpdateSupplierDto extends PartialType(CreateSupplierDto) {}
