import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  registerDecorator,
  ValidateNested,
  type ValidationArguments,
} from 'class-validator';

import { MAX_ATTACHMENTS_PER_TURN } from '../internal/attachments';

/** Máximo de caracteres por turno; espejo del límite del cliente. */
export const MAX_TURN_LENGTH = 8000;

/** Máximo de turnos que el cliente puede mandar de una vez. */
export const MAX_TURNS = 60;

/**
 * El texto del turno no puede ir en blanco, SALVO que el usuario mande solo
 * archivos (una foto de la factura sin escribir nada).
 */
function IsTextOrAttachments(): PropertyDecorator {
  return (target, property_name) => {
    registerDecorator({
      name: 'isTextOrAttachments',
      target: target.constructor,
      propertyName: String(property_name),
      options: { message: 'El mensaje no puede estar vacío' },
      validator: {
        validate(value: unknown, args: ValidationArguments): boolean {
          const ids = (args.object as { attachment_ids?: unknown }).attachment_ids;
          const has_attachments = Array.isArray(ids) && ids.length > 0;
          return typeof value === 'string' && (value.trim().length > 0 || has_attachments);
        },
      },
    });
  };
}

export class AiChatTurnDto {
  @ApiProperty({ enum: ['user', 'assistant'] })
  @IsIn(['user', 'assistant'], { message: 'El rol del mensaje es inválido' })
  role!: 'user' | 'assistant';

  @ApiProperty({ maxLength: MAX_TURN_LENGTH })
  @IsString({ message: 'El contenido del mensaje debe ser texto' })
  @IsTextOrAttachments()
  @MaxLength(MAX_TURN_LENGTH, {
    message: `El mensaje no puede exceder ${MAX_TURN_LENGTH} caracteres`,
  })
  content!: string;

  @ApiPropertyOptional({
    type: [String],
    description: 'Fotos/PDF del turno: ids devueltos por `POST /ai/attachments`.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_ATTACHMENTS_PER_TURN, {
    message: `No puedes adjuntar más de ${MAX_ATTACHMENTS_PER_TURN} archivos por mensaje`,
  })
  @IsUUID('all', { each: true, message: 'La referencia del archivo adjunto es inválida' })
  attachment_ids?: string[];
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
