import { ApiProperty } from '@nestjs/swagger';
import { IsString, Matches } from 'class-validator';

/**
 * Payload de `POST /cash-register/close`.
 *
 * `closing_balance` es el cash físico contado por el cajero al cerrar.
 * El servidor calcula `expected_balance` = opening + sum(IN) - sum(OUT)
 * de logs `affects_balance = true`, y `difference = closing - expected`.
 *
 * Si `difference` es distinto de 0 → el turno queda cerrado igual
 * (registro del descuadre); el cliente puede mostrar la alerta.
 */
export class CloseCashRegisterDto {
  @ApiProperty({ example: '150.00', description: 'Cash físico al cerrar el turno.' })
  @IsString()
  @Matches(/^\d+(\.\d{1,2})?$/, {
    message: 'closing_balance debe ser un decimal positivo con hasta 2 decimales',
  })
  closing_balance!: string;
}
