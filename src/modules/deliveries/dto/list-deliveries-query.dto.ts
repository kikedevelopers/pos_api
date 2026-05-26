import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsBooleanString,
  IsDateString,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Min,
} from 'class-validator';

import { DELIVERY_PAYMENT_METHODS } from './create-delivery.dto';
import type { DeliveryPaymentMethod } from '../entities/delivery.entity';

/**
 * Query de `GET /deliveries`.
 *
 * Contrato Domiciliarios: `company_id` (filtra por domiciliario),
 * `payment_method`, `date_from`/`date_to`, `search`, `include_archived`.
 *
 * IMPORTANTE: el filtro `company_id` de esta query NO es el tenant — es el id
 * del DOMICILIARIO (`delivery_companies.id`). El tenant SIEMPRE viene del JWT
 * vía `@CurrentCompany()`; nunca del query.
 */
export class ListDeliveriesQueryDto {
  @ApiPropertyOptional({
    example: 1,
    description: 'ID del domiciliario (delivery_companies.id) por el que filtrar.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'company_id debe ser entero' })
  @Min(1)
  company_id?: number;

  @ApiPropertyOptional({
    enum: DELIVERY_PAYMENT_METHODS,
    example: 'cash_register',
    description: 'Filtra por método de pago.',
  })
  @IsOptional()
  @IsString()
  @IsIn([...DELIVERY_PAYMENT_METHODS])
  payment_method?: DeliveryPaymentMethod;

  @ApiPropertyOptional({ example: '2026-05-01', description: 'ISO date (YYYY-MM-DD).' })
  @IsOptional()
  @IsDateString({}, { message: 'date_from debe ser un ISO date string válido (YYYY-MM-DD)' })
  date_from?: string;

  @ApiPropertyOptional({ example: '2026-05-31', description: 'ISO date (YYYY-MM-DD).' })
  @IsOptional()
  @IsDateString({}, { message: 'date_to debe ser un ISO date string válido (YYYY-MM-DD)' })
  date_to?: string;

  @ApiPropertyOptional({
    example: 'maría',
    description: 'Substring case-insensitive sobre recipient_name, destination_address o ticket.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  search?: string;

  @ApiPropertyOptional({
    example: 'false',
    description: 'Incluir domicilios archivados. Default false.',
  })
  @IsOptional()
  @IsBooleanString()
  include_archived?: string;
}
