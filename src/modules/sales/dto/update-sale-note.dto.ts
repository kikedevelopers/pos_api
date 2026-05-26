import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * Payload de `PATCH /sales/:id/note`. Actualiza SOLO la nota a NIVEL TICKET
 * (`sale_invoices.notes`) de la venta indicada.
 *
 * El cliente PlacePos la captura desde el modal de éxito post-venta (el
 * cajero agrega una nota al ticket recién creado). Idempotente: reenviar el
 * mismo `notes` deja el mismo estado.
 *
 * `notes` acepta `null` para limpiar la nota existente. El service hace
 * `trim()` y normaliza cadena vacía a `null` (paridad PlacePos).
 */
export class UpdateSaleNoteDto {
  @ApiPropertyOptional({
    example: 'Pago en efectivo + transferencia.',
    description: 'Nota del ticket completo. null o cadena vacía limpia la nota.',
    nullable: true,
    maxLength: 500,
  })
  @IsOptional()
  @IsString()
  @MaxLength(500, { message: 'notes no puede exceder 500 caracteres' })
  notes?: string | null;
}
