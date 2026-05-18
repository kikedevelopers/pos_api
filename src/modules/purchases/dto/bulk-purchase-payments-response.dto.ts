import { ApiProperty } from '@nestjs/swagger';

import { PurchaseCreditStatus } from '../entities/purchase-credit.entity';

import type { BulkAppliedPurchasePayment } from '../actions/process-bulk-purchase-payments.action';

/**
 * Item de la respuesta del bulk. Espejo PlacePos.
 */
export class BulkAppliedPurchasePaymentDto {
  @ApiProperty({ example: 1 })
  purchase_id!: number;

  @ApiProperty({ example: 42 })
  payment_id!: number;

  @ApiProperty({ example: 'ABO-042' })
  payment_number!: string;

  @ApiProperty({ enum: PurchaseCreditStatus, example: PurchaseCreditStatus.PARTIALLY_PAID })
  credit_status!: PurchaseCreditStatus;

  @ApiProperty({ example: 1200.5 })
  credit_balance!: number;
}

/**
 * Shape de respuesta de `POST /purchases/bulk-payments`. Espejo PlacePos.
 */
export class BulkPurchasePaymentsResponseDto {
  @ApiProperty({ example: 3 })
  processed!: number;

  @ApiProperty({ type: [BulkAppliedPurchasePaymentDto] })
  payments!: BulkAppliedPurchasePaymentDto[];
}

export function toBulkPurchasePaymentsResponseDto(
  processed: number,
  payments: BulkAppliedPurchasePayment[],
): BulkPurchasePaymentsResponseDto {
  return {
    processed,
    payments: payments.map((p) => ({
      purchase_id: p.purchase_id,
      payment_id: p.payment_id,
      payment_number: p.payment_number,
      credit_status: p.credit_status,
      credit_balance: p.credit_balance,
    })),
  };
}
