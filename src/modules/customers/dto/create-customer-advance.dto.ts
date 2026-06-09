import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsPositive,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';

import type { AdvanceDestinationType } from '../entities/customer-advance.entity';

const ADVANCE_DESTINATION_TYPES: AdvanceDestinationType[] = ['cash_register', 'bank', 'wallet'];

/**
 * Payload de `POST /customers/:id/advances`.
 *
 * --------------------------------------------------------------------------
 * Validación (contrato `CONTRACT_customer_advance_archive.md`)
 * --------------------------------------------------------------------------
 *
 *   - `amount` > 0 (numérico, máx 2 decimales).
 *   - `description` no vacío (se hace trim; rechaza solo-espacios).
 *   - `destination_type` ∈ {cash_register, bank, wallet}.
 *   - `destination_id` REQUERIDO para `bank` y `wallet`; OPCIONAL/ignorado para
 *     `cash_register` (se usa la caja del usuario autenticado, resuelta
 *     server-side).
 *
 * Campos prohibidos: `company_id`, `created_by*` los asigna el service desde
 * el JWT; cualquier extra lo strippea el ValidationPipe global.
 */
export class CreateCustomerAdvanceDto {
  @ApiProperty({ example: 12000000, description: 'Monto del anticipo. Debe ser > 0.' })
  @IsNumber({ maxDecimalPlaces: 2 }, { message: 'amount debe ser numérico con máx 2 decimales' })
  @IsPositive({ message: 'amount debe ser mayor que 0' })
  amount!: number;

  @ApiProperty({
    example: 'Anticipo para pedido de mercancía',
    maxLength: 500,
    description: 'Concepto del anticipo. No puede estar vacío.',
  })
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value))
  @IsNotEmpty({ message: 'description no puede estar vacío' })
  @MaxLength(500)
  description!: string;

  @ApiProperty({
    enum: ADVANCE_DESTINATION_TYPES,
    example: 'cash_register',
    description: 'A qué cuenta entra el dinero del anticipo.',
  })
  @IsIn(ADVANCE_DESTINATION_TYPES, {
    message: 'destination_type debe ser uno de: cash_register, bank, wallet',
  })
  destination_type!: AdvanceDestinationType;

  @ApiPropertyOptional({
    example: 5,
    description:
      'Id de la cuenta destino. Requerido para bank/wallet; ignorado para cash_register (se usa la caja del usuario).',
  })
  // Requerido (int >= 1) solo cuando el destino es bank o wallet. Para
  // cash_register, `@ValidateIf` desactiva TODAS las validaciones siguientes,
  // de modo que el campo es opcional/ignorado (la caja la resuelve el server
  // por user_id).
  @ValidateIf((dto: CreateCustomerAdvanceDto) => dto.destination_type !== 'cash_register')
  @IsInt({ message: 'destination_id debe ser un entero' })
  @Min(1, { message: 'destination_id debe ser >= 1' })
  destination_id?: number;
}
