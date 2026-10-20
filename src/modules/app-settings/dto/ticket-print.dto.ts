import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ArrayMinSize, ArrayUnique, IsArray, IsBoolean, IsIn, IsOptional } from 'class-validator';

import {
  TICKET_PRINT_TICKET_TYPES,
  type TicketPrintTicketType,
} from '../internal/ticket-print-config';

/**
 * Configuración de impresión del ticket — espejo de
 * `placepos/src/renderer/src/api/requests/app-settings/types.ts →
 * TicketPrintConfig`.
 *
 * Cada espacio (observaciones / firma) se imprime en el ticket térmico, entre
 * el TOTAL y el "Gracias por su compra", cuando está activo Y el ticket es de
 * uno de sus tipos (`SALE` venta, `ORDER` pedido, `CREDIT` crédito).
 */
export class TicketPrintConfigDto {
  @ApiProperty({ example: false, description: 'Espacio "Observaciones: ____".' })
  observations_enabled!: boolean;

  @ApiProperty({ enum: TICKET_PRINT_TICKET_TYPES, isArray: true, example: ['ORDER'] })
  observations_ticket_types!: TicketPrintTicketType[];

  @ApiProperty({ example: false, description: 'Línea de firma.' })
  signature_enabled!: boolean;

  @ApiProperty({ enum: TICKET_PRINT_TICKET_TYPES, isArray: true, example: ['CREDIT', 'ORDER'] })
  signature_ticket_types!: TicketPrintTicketType[];
}

const TicketTypesValidators = (): PropertyDecorator => {
  const decorators = [
    IsOptional(),
    IsArray(),
    ArrayMinSize(1, { message: 'Selecciona al menos un tipo de ticket' }),
    ArrayUnique(),
    IsIn(TICKET_PRINT_TICKET_TYPES, { each: true }),
  ];
  return (target, key) => decorators.forEach((decorator) => decorator(target, key));
};

/**
 * Payload de `PUT /app-settings/ticket-print`. PARCIAL: cada control envía solo
 * su campo; los ausentes conservan su valor. Al menos uno es obligatorio (lo
 * valida la action). Solo un administrador (canAccessSettings) puede mutarlo.
 */
export class UpdateTicketPrintDto {
  @ApiPropertyOptional({ example: true })
  @IsOptional()
  @IsBoolean()
  observations_enabled?: boolean;

  @ApiPropertyOptional({ enum: TICKET_PRINT_TICKET_TYPES, isArray: true, example: ['ORDER'] })
  @TicketTypesValidators()
  observations_ticket_types?: TicketPrintTicketType[];

  @ApiPropertyOptional({ example: false })
  @IsOptional()
  @IsBoolean()
  signature_enabled?: boolean;

  @ApiPropertyOptional({ enum: TICKET_PRINT_TICKET_TYPES, isArray: true, example: ['CREDIT'] })
  @TicketTypesValidators()
  signature_ticket_types?: TicketPrintTicketType[];
}
