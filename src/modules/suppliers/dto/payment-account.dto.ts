import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsNotEmpty, IsOptional, IsString, MaxLength, ValidateIf } from 'class-validator';

/**
 * Sub-DTO `payment_accounts[]` — espejo placepos (`SupplierPaymentAccount`).
 *
 * Cuenta bancaria o billetera a la que se le puede consignar/pagar al
 * proveedor. Persistida embebida en `suppliers.payment_accounts` (JSONB);
 * no tiene tabla propia.
 *
 * Validación espejo del zod schema del cliente
 * (`Suppliers/components/SupplierForm/schemas/supplier.schema.ts`):
 *   - `entity_name`, `account_type`, `account_number`, `document_number`
 *     son strings no-vacíos (`min(1)` en zod).
 *   - `document_type` ∈ {`CC`, `NIT`}.
 *   - `agreement_number` puede ser string o null.
 */
export class SupplierPaymentAccountDto {
  @ApiProperty({ example: 'Bancolombia', maxLength: 100 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  entity_name!: string;

  @ApiProperty({ example: 'Ahorros', maxLength: 50 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  account_type!: string;

  @ApiProperty({ example: '12345678901', maxLength: 30 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(30)
  account_number!: string;

  @ApiProperty({ enum: ['CC', 'NIT'], example: 'CC' })
  @IsIn(['CC', 'NIT'])
  document_type!: 'CC' | 'NIT';

  @ApiProperty({ example: '1098765432', maxLength: 30 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(30)
  document_number!: string;

  @ApiPropertyOptional({ example: 'CONV-123', maxLength: 50, nullable: true })
  @IsOptional()
  // Aceptamos string o null explícito (placepos lo serializa así). `ValidateIf`
  // saltea la validación cuando el cliente envía null literal.
  @ValidateIf((_o, v) => v !== null)
  @IsString()
  @MaxLength(50)
  agreement_number!: string | null;
}
