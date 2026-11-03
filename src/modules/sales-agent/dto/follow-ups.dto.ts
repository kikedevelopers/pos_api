import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

import { FOLLOW_UP_MAX_LENGTH } from '../internal/follow-up-prompt';

/** `POST /sales-agent/follow-ups/draft` — pedir un saludo de seguimiento. */
export class DraftFollowUpDto {
  @ApiProperty({ description: 'Cliente al que se le hará seguimiento.' })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  customer_id!: number;

  @ApiPropertyOptional({
    description: 'Borradores ya mostrados y descartados (el nuevo debe ser distinto).',
    type: [String],
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @IsString({ each: true })
  @MaxLength(FOLLOW_UP_MAX_LENGTH, { each: true })
  previous_messages?: string[];
}

/** `POST /sales-agent/follow-ups` — registrar un seguimiento ya enviado. */
export class RecordFollowUpDto {
  @ApiProperty()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  customer_id!: number;

  @ApiProperty({ description: 'Texto exacto que se envió.' })
  @IsString()
  @MinLength(1)
  @MaxLength(FOLLOW_UP_MAX_LENGTH)
  message!: string;

  @ApiProperty({ description: 'JID al que se envió (lo resuelve WhatsApp en el escritorio).' })
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  chat_id!: string;

  @ApiProperty({ description: 'Número del cliente (dígitos con indicativo).' })
  @IsString()
  @MinLength(7)
  @MaxLength(32)
  phone!: string;

  @ApiPropertyOptional({ type: [Number] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsInt({ each: true })
  recalled_product_ids?: number[];

  @ApiPropertyOptional({ type: [Number] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsInt({ each: true })
  suggested_product_ids?: number[];
}
