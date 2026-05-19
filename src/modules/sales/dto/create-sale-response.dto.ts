import { ApiProperty } from '@nestjs/swagger';

/**
 * Shape de respuesta de `POST /sales`. Espeja byte-por-byte el retorno de
 * `placepos/src/main/database/saleOperations.ts → createOrder`:
 *
 *     {
 *       success: true,
 *       message: 'Pedido registrado exitosamente',
 *       invoice_id: <number>,
 *       ticket_number: '<string>'
 *     }
 *
 * Después de pasar por `ResponseWrapperInterceptor`, el cliente recibe:
 *
 *     { success: true, payload: { success, message, invoice_id, ticket_number } }
 *
 * que es exactamente lo que el `SaleController.ipcMain.handle('order:create')`
 * de PlacePos espera leer en `result.payload.invoice_id` /
 * `result.payload.ticket_number`.
 *
 * Si en el futuro algún consumidor necesita el aggregate completo (líneas,
 * pagos, credit), debe llamar a `GET /sales/:id` con el `invoice_id` que
 * devolvió este endpoint — mismo patrón que el modo servidor/cliente.
 */
export class CreateSaleResponseDto {
  @ApiProperty({ example: true })
  success!: true;

  @ApiProperty({ example: 'Pedido registrado exitosamente' })
  message!: string;

  @ApiProperty({ example: 5 })
  invoice_id!: number;

  @ApiProperty({ example: '001' })
  ticket_number!: string;
}

export function toCreateSaleResponseDto(invoiceId: number, ticketNumber: string): CreateSaleResponseDto {
  return {
    success: true,
    message: 'Pedido registrado exitosamente',
    invoice_id: invoiceId,
    ticket_number: ticketNumber,
  };
}
