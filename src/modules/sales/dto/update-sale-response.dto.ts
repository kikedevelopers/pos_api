import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Shape de respuesta de `PUT /sales/:id`. Espeja byte-por-byte el retorno de
 * `placepos/src/main/database/editOperations.ts → editTicket`:
 *
 *     {
 *       success: true,
 *       message: 'Venta editada exitosamente. Nota crédito: NC-001.',
 *       creditNoteId: 12,
 *       creditNoteNumber: 'NC-001',
 *       debitNoteId: null,
 *       debitNoteNumber: null
 *     }
 *
 * Tras `ResponseWrapperInterceptor`, el cliente recibe:
 *
 *     { success: true, payload: { success, message, creditNoteId, ... } }
 *
 * que coincide con lo que `SaleController.ipcMain.handle('ticket:edit')` lee
 * en `result.payload.creditNoteId` / `result.payload.debitNoteId`.
 *
 * Si el flujo necesita el aggregate completo de la venta tras la edición,
 * debe llamar a `GET /sales/:id` con el invoiceId — mismo patrón que el
 * modo servidor/cliente.
 */
export class UpdateSaleResponseDto {
  @ApiProperty({ example: true })
  success!: true;

  @ApiProperty({ example: 'Venta editada exitosamente. Nota crédito: NC-001.' })
  message!: string;

  @ApiPropertyOptional({ example: 12, nullable: true })
  creditNoteId!: number | null;

  @ApiPropertyOptional({ example: 'NC-001', nullable: true })
  creditNoteNumber!: string | null;

  @ApiPropertyOptional({ example: 14, nullable: true })
  debitNoteId!: number | null;

  @ApiPropertyOptional({ example: 'ND-001', nullable: true })
  debitNoteNumber!: string | null;
}

/**
 * Shape de respuesta de `POST /sales/:id/void`. Espeja byte-por-byte el
 * retorno de `placepos/src/main/database/voidOperations.ts → voidTicket`.
 *
 * Para `ORDER` la respuesta es `{ success, message, creditNoteId: null,
 * creditNoteNumber: null }` (soft-delete). Para `SALE` se emite una NC
 * FULL_VOID y se devuelven sus identificadores.
 *
 * Después del `ResponseWrapperInterceptor`:
 *
 *     { success: true, payload: { success, message, creditNoteId, creditNoteNumber } }
 *
 * Mapea a lo que el handler IPC `ticket:void` espera en
 * `result.payload.creditNoteId` / `result.payload.creditNoteNumber`.
 */
export class VoidSaleResponseDto {
  @ApiProperty({ example: true })
  success!: true;

  @ApiProperty({ example: 'Venta anulada exitosamente. Se generó nota crédito.' })
  message!: string;

  @ApiPropertyOptional({ example: 12, nullable: true })
  creditNoteId!: number | null;

  @ApiPropertyOptional({ example: 'NC-001', nullable: true })
  creditNoteNumber!: string | null;
}

export function toUpdateSaleResponseDto(input: {
  message: string;
  creditNoteId: number | null;
  creditNoteNumber: string | null;
  debitNoteId: number | null;
  debitNoteNumber: string | null;
}): UpdateSaleResponseDto {
  return {
    success: true,
    message: input.message,
    creditNoteId: input.creditNoteId,
    creditNoteNumber: input.creditNoteNumber,
    debitNoteId: input.debitNoteId,
    debitNoteNumber: input.debitNoteNumber,
  };
}

export function toVoidSaleResponseDto(input: {
  message: string;
  creditNoteId: number | null;
  creditNoteNumber: string | null;
}): VoidSaleResponseDto {
  return {
    success: true,
    message: input.message,
    creditNoteId: input.creditNoteId,
    creditNoteNumber: input.creditNoteNumber,
  };
}
