import { ApiProperty } from '@nestjs/swagger';

import { CustomerResponseDto } from './customer-response.dto';
import { CustomerAdvanceResponseDto } from './customer-advance-response.dto';

/**
 * Respuesta de `POST /customers/:id/advances`.
 *
 * Contrato: `{ advance, customer }` — el anticipo creado + el customer ya con
 * `advance_balance` actualizado, para que el frontend refresque la fila sin un
 * GET adicional.
 */
export class CreateCustomerAdvanceResponseDto {
  @ApiProperty({ type: CustomerAdvanceResponseDto })
  advance!: CustomerAdvanceResponseDto;

  @ApiProperty({ type: CustomerResponseDto })
  customer!: CustomerResponseDto;
}
