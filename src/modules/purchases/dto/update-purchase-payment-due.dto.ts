import { ApiProperty } from '@nestjs/swagger';
import { IsDefined, IsString, Matches, ValidateIf } from 'class-validator';

/**
 * Payload de `PATCH /purchases/:id/payment-due`: cambia (o quita) el plazo de
 * pago de una compra sin tocar líneas, totales ni inventario.
 *
 * `payment_due_date` es OBLIGATORIO en el body: un día `YYYY-MM-DD` (vence al
 * final de ese día en Bogotá) o `null` explícito para dejar la compra sin
 * plazo. La regla "no anterior a hoy" vive en la action.
 */
export class UpdatePurchasePaymentDueDto {
  @ApiProperty({
    example: '2026-11-06',
    nullable: true,
    description:
      'Día (YYYY-MM-DD, calendario de Colombia) en que vence el pago, al final del día. null = sin plazo.',
  })
  @IsDefined({ message: 'payment_due_date es obligatorio (usa null para quitar el plazo)' })
  @ValidateIf((_o, v) => v !== null)
  @IsString({ message: 'payment_due_date debe ser texto' })
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'payment_due_date debe tener formato YYYY-MM-DD' })
  payment_due_date!: string | null;
}
