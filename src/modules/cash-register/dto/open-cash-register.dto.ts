import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, Matches } from 'class-validator';

/**
 * Payload de `POST /cash-register/open`.
 *
 * `opening_balance` es el cash físico contado por el cajero al abrir el
 * turno. Opcional — default 0 si se omite.
 */
export class OpenCashRegisterDto {
  @ApiPropertyOptional({
    example: '0.00',
    description: 'Cash físico al abrir el turno. Default 0.',
  })
  @IsOptional()
  @IsString()
  @Matches(/^\d+(\.\d{1,2})?$/, {
    message: 'opening_balance debe ser un decimal positivo con hasta 2 decimales',
  })
  opening_balance?: string;
}
