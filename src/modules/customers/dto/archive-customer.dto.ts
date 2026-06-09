import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean } from 'class-validator';

/**
 * Payload de `PATCH /customers/:id/archive`.
 *
 * `is_archived` es el ÚNICO campo aceptado. Setear el mismo valor que ya tiene
 * el cliente NO falla (idempotente, contrato). Cualquier otro campo es
 * strippeado por `whitelist: true` del ValidationPipe global y rechazado por
 * `forbidNonWhitelisted: true`.
 */
export class ArchiveCustomerDto {
  @ApiProperty({
    example: true,
    description: 'true ⇒ archivar el cliente; false ⇒ desarchivar.',
  })
  @IsBoolean({ message: 'is_archived debe ser booleano' })
  is_archived!: boolean;
}
