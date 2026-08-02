import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';

/** Máximo de caracteres por turno; espejo del límite del cliente. */
export const MAX_TURN_LENGTH = 8000;

/** Máximo de turnos que el cliente puede mandar de una vez. */
export const MAX_TURNS = 60;

export class AiChatTurnDto {
  @ApiProperty({ enum: ['user', 'assistant'] })
  @IsIn(['user', 'assistant'], { message: 'El rol del mensaje es inválido' })
  role!: 'user' | 'assistant';

  @ApiProperty({ maxLength: MAX_TURN_LENGTH })
  @IsString({ message: 'El contenido del mensaje debe ser texto' })
  @MinLength(1, { message: 'El mensaje no puede estar vacío' })
  @MaxLength(MAX_TURN_LENGTH, {
    message: `El mensaje no puede exceder ${MAX_TURN_LENGTH} caracteres`,
  })
  content!: string;
}

export class AiChatRequestDto {
  @ApiProperty({ type: [AiChatTurnDto], description: 'Historial completo, el último es el nuevo.' })
  @IsArray()
  @ArrayMinSize(1, { message: 'Debes enviar al menos un mensaje' })
  @ArrayMaxSize(MAX_TURNS, { message: `No puedes enviar más de ${MAX_TURNS} mensajes` })
  @ValidateNested({ each: true })
  @Type(() => AiChatTurnDto)
  turns!: AiChatTurnDto[];

  @ApiPropertyOptional({
    description: 'Modelo a usar. Si no está permitido, se usa el de defecto.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(80)
  model?: string;
}
