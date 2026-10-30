import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsArray, IsOptional, IsString, MaxLength } from 'class-validator';

import { PROFILE_LIMITS, type ProductAttribute, type RelatedProductRef } from '../internal/profile';

/**
 * Payload de `PUT /inventory/:id/assistant-profile`. Las listas se sanean en el
 * servicio (recorte, duplicados, topes), así que aquí solo se valida la forma.
 */
export class UpdateAssistantProfileDto {
  @ApiPropertyOptional({ example: 'Contenedor de icopor con dos compartimentos.' })
  @IsOptional()
  @IsString()
  @MaxLength(PROFILE_LIMITS.description)
  description?: string;

  @ApiPropertyOptional({ type: [String], example: ['hamburguesa con papas', 'domicilio'] })
  @IsOptional()
  @IsArray()
  uses?: string[];

  @ApiPropertyOptional({ example: [{ name: 'compartimentos', value: '2' }] })
  @IsOptional()
  @IsArray()
  attributes?: ProductAttribute[];

  @ApiPropertyOptional({ type: [String], example: ['portacomida', 'caja de hamburguesa'] })
  @IsOptional()
  @IsArray()
  aliases?: string[];

  @ApiPropertyOptional({ example: [{ product_id: 12, kind: 'upgrade' }] })
  @IsOptional()
  @IsArray()
  related?: RelatedProductRef[];
}
