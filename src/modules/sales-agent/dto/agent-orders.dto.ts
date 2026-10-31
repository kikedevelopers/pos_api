import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min } from 'class-validator';

import {
  SALES_AGENT_ORDER_STATUSES,
  type SalesAgentOrderStatus,
} from '../entities/sales-agent-order.entity';
import type { AgentOrderStatusFilter } from '../sales-agent-orders.service';

const STATUS_FILTERS: readonly AgentOrderStatusFilter[] = [...SALES_AGENT_ORDER_STATUSES, 'all'];
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Query de `GET /sales-agent-orders`. */
export class ListAgentOrdersQueryDto {
  @ApiPropertyOptional({ enum: STATUS_FILTERS, default: 'pending' })
  @IsOptional()
  @IsIn(STATUS_FILTERS)
  status?: AgentOrderStatusFilter;

  @ApiPropertyOptional({ example: '2026-10-01', description: 'Día Colombia (con "to").' })
  @IsOptional()
  @Matches(DATE, { message: 'from debe ser YYYY-MM-DD' })
  from?: string;

  @ApiPropertyOptional({ example: '2026-10-31', description: 'Día Colombia (con "from").' })
  @IsOptional()
  @Matches(DATE, { message: 'to debe ser YYYY-MM-DD' })
  to?: string;

  @ApiPropertyOptional({ description: 'Referencia, nombre o teléfono del cliente.' })
  @IsOptional()
  @IsString()
  @MaxLength(80)
  search?: string;

  @ApiPropertyOptional({ default: 1, minimum: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @ApiPropertyOptional({ default: 25, minimum: 1, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}

/** Payload de `PATCH /sales-agent-orders/:id/status`. */
export class UpdateAgentOrderStatusDto {
  @ApiProperty({ enum: SALES_AGENT_ORDER_STATUSES })
  @IsIn(SALES_AGENT_ORDER_STATUSES)
  status!: SalesAgentOrderStatus;

  @ApiPropertyOptional({ description: 'Nota del cambio (p. ej. por qué se descarta). Máx. 250.' })
  @IsOptional()
  @IsString()
  @MaxLength(250)
  note?: string;
}

/** Payload de `POST /sales-agent-orders/:id/link-ticket`. */
export class LinkAgentOrderTicketDto {
  @ApiProperty({ description: 'Id del ticket (sale_invoices.id) que se registró en el POS.' })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  sale_invoice_id!: number;
}
