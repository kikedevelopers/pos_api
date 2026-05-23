import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsString, Min } from 'class-validator';

/**
 * Tipos de fuente aceptados al pagar un corte. Espejo de
 * `PurchasePaymentSource` / `ExpenseSourceType`.
 */
export const FIXED_EXPENSE_PAY_SOURCE_TYPES = ['wallet', 'bank', 'cash_register'] as const;
export type FixedExpensePaySource = (typeof FIXED_EXPENSE_PAY_SOURCE_TYPES)[number];

/**
 * Payload de `PUT /fixed-expenses/:id/periods/:periodId/pay`.
 *
 * Marca el corte como PAID y, dentro de la misma transacción, materializa
 * el `Expense` real + `FinancialMovement(EXPENSE_PAYMENT)` desde la fuente
 * indicada. Para `cash_register`, `source_id` se ignora y se resuelve la
 * caja del actor (paridad PlacePos blindaje cross-cashier).
 */
export class PayFixedExpensePeriodDto {
  @ApiProperty({
    enum: FIXED_EXPENSE_PAY_SOURCE_TYPES,
    example: 'bank',
    description: 'Tipo de cuenta origen del pago.',
  })
  @IsString()
  @IsIn([...FIXED_EXPENSE_PAY_SOURCE_TYPES], {
    message: 'Fuente del pago inválida. Usa wallet, bank o cash_register.',
  })
  source_type!: FixedExpensePaySource;

  @ApiProperty({
    example: 1,
    description: 'ID de la cuenta origen (debe pertenecer a la company).',
  })
  @Type(() => Number)
  @IsInt({ message: 'source_id debe ser entero' })
  @Min(1, { message: 'Debe seleccionarse una caja, banco o billetera.' })
  source_id!: number;
}
