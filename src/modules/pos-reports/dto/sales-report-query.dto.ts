import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Min,
} from 'class-validator';

export const NOTE_FILTERS = [
  'ACTIVE_ONLY',
  'VOIDED_ONLY',
  'FULL_VOID',
  'PARTIAL_VOID',
  'DEBIT_NOTES',
  'WITH_ADJUSTMENTS',
] as const;
export type NoteFilter = (typeof NOTE_FILTERS)[number];

export const TICKET_TYPE_VALUES = ['ORDER', 'SALE', 'NOTE'] as const;
export type TicketTypeValue = (typeof TICKET_TYPE_VALUES)[number];

/**
 * Query del endpoint `GET /pos-reports/sales`. Espejo PlacePos.
 *
 * - `dateFrom` / `dateTo` son REQUERIDOS (validado por el handler con 400 si
 *   faltan; aquí los marcamos opcionales para que el ValidationPipe no
 *   rechace antes y la respuesta sea byte-idéntica).
 * - `ticketTypes` viene como CSV en la URL (ej `SALE,ORDER`). El transformer
 *   lo split a array para que la action lo consuma.
 * - `noteFilter` es uno de los presets de PlacePos.
 * - `showDeleted` aceptado como `'true'` (querystring).
 */
export class SalesReportQueryDto {
  @ApiPropertyOptional({ example: '2026-05-01' })
  @IsOptional()
  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'Formato de fecha inválido en dateFrom' })
  dateFrom?: string;

  @ApiPropertyOptional({ example: '2026-05-31' })
  @IsOptional()
  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'Formato de fecha inválido en dateTo' })
  dateTo?: string;

  @ApiPropertyOptional({ example: 'V-001' })
  @IsOptional()
  @IsString()
  @MaxLength(100, { message: 'search demasiado largo (máx 100 caracteres)' })
  search?: string;

  @ApiPropertyOptional({ example: 'SALE,ORDER', enum: TICKET_TYPE_VALUES, isArray: true })
  @IsOptional()
  @Transform(({ value }): string[] | undefined => {
    if (typeof value === 'string') {
      return value
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    }
    if (Array.isArray(value)) {
      return value.filter((v): v is string => typeof v === 'string');
    }
    return undefined;
  })
  @IsArray()
  @IsIn([...TICKET_TYPE_VALUES], { each: true, message: 'ticketTypes contiene valores inválidos' })
  ticketTypes?: TicketTypeValue[];

  @ApiPropertyOptional({ enum: NOTE_FILTERS })
  @IsOptional()
  @IsIn([...NOTE_FILTERS], { message: 'noteFilter inválido' })
  noteFilter?: NoteFilter;

  @ApiPropertyOptional({ example: false })
  @IsOptional()
  @Transform(({ value }): boolean => value === true || value === 'true')
  @IsBoolean()
  showDeleted?: boolean;

  /**
   * IDs de categoría (CSV en la URL, ej `3,7`). Filtra los tickets que
   * contengan AL MENOS UN producto de alguna de estas categorías. Espejo
   * PlacePos. Vacío/undefined = sin filtro de categoría.
   */
  @ApiPropertyOptional({ example: '3,7', isArray: true, type: Number })
  @IsOptional()
  @Transform(({ value }): number[] | undefined => {
    const raw =
      typeof value === 'string'
        ? value.split(',')
        : Array.isArray(value)
          ? (value as unknown[])
          : [];
    const ids = raw
      .map((v) => Number(v))
      .filter((n) => Number.isInteger(n) && n > 0);
    return ids.length > 0 ? ids : undefined;
  })
  @IsArray()
  @IsInt({ each: true, message: 'categoryIds contiene valores inválidos' })
  @Min(1, { each: true, message: 'categoryIds contiene valores inválidos' })
  categoryIds?: number[];
}

/**
 * Query del endpoint `GET /pos-reports/dashboard-sales`.
 */
export class DashboardSalesQueryDto {
  @ApiPropertyOptional({ example: '2026-05-01' })
  @IsOptional()
  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'Formato de fecha inválido en dateFrom' })
  dateFrom?: string;

  @ApiPropertyOptional({ example: '2026-05-31' })
  @IsOptional()
  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'Formato de fecha inválido en dateTo' })
  dateTo?: string;

  @ApiPropertyOptional({ enum: NOTE_FILTERS })
  @IsOptional()
  @IsIn([...NOTE_FILTERS], { message: 'noteFilter inválido' })
  noteFilter?: NoteFilter;

  @ApiPropertyOptional({ example: false })
  @IsOptional()
  @Transform(({ value }): boolean => value === true || value === 'true')
  @IsBoolean()
  showDeleted?: boolean;
}
