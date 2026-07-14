import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
} from 'class-validator';

// ─── Tableros ────────────────────────────────────────────────────────────────

export class CreateBoardDto {
  @ApiProperty({ example: 'Pendiente' })
  @IsString()
  @IsNotEmpty({ message: 'El título del tablero es obligatorio' })
  @MaxLength(120)
  title!: string;

  @ApiPropertyOptional({ description: 'Idempotencia por intento (UUID v4).' })
  @IsOptional()
  @IsUUID('4')
  client_operation_id?: string;
}

export class UpdateBoardDto {
  @ApiProperty({ example: 'En curso' })
  @IsString()
  @IsNotEmpty({ message: 'El título del tablero es obligatorio' })
  @MaxLength(120)
  title!: string;
}

export class MoveBoardDto {
  @ApiPropertyOptional({
    example: 3,
    nullable: true,
    description: 'Id del tablero que queda a la IZQUIERDA del destino (null = extremo).',
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  before_id?: number | null;

  @ApiPropertyOptional({
    example: 5,
    nullable: true,
    description: 'Id del tablero que queda a la DERECHA del destino (null = extremo).',
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  after_id?: number | null;
}

// ─── Tarjetas ────────────────────────────────────────────────────────────────

export class CreateCardDto {
  @ApiProperty({ example: 'Llamar al proveedor' })
  @IsString()
  @IsNotEmpty({ message: 'El título de la tarjeta es obligatorio' })
  @MaxLength(280)
  title!: string;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string | null;

  @ApiPropertyOptional({ description: 'Idempotencia por intento (UUID v4).' })
  @IsOptional()
  @IsUUID('4')
  client_operation_id?: string;
}

export class UpdateCardDto {
  @ApiPropertyOptional({ example: 'Llamar al proveedor mañana' })
  @IsOptional()
  @IsString()
  @IsNotEmpty({ message: 'El título no puede quedar vacío' })
  @MaxLength(280)
  title?: string;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string | null;
}

export class MoveCardDto {
  @ApiProperty({ example: 7, description: 'Tablero destino.' })
  @IsInt()
  @Min(1)
  board_id!: number;

  @ApiPropertyOptional({
    example: 12,
    nullable: true,
    description: 'Id de la tarjeta que queda ENCIMA del destino (null = arriba del todo).',
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  before_id?: number | null;

  @ApiPropertyOptional({
    example: 18,
    nullable: true,
    description: 'Id de la tarjeta que queda DEBAJO del destino (null = abajo del todo).',
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  after_id?: number | null;
}

// ─── Checklist ───────────────────────────────────────────────────────────────

export class CreateChecklistItemDto {
  @ApiProperty({ example: 'Confirmar stock' })
  @IsString()
  @IsNotEmpty({ message: 'El texto de la tarea es obligatorio' })
  @MaxLength(500)
  text!: string;
}

export class UpdateChecklistItemDto {
  @ApiPropertyOptional({ example: 'Confirmar stock con el proveedor' })
  @IsOptional()
  @IsString()
  @IsNotEmpty({ message: 'El texto no puede quedar vacío' })
  @MaxLength(500)
  text?: string;

  @ApiPropertyOptional({ example: true })
  @IsOptional()
  @IsBoolean()
  is_done?: boolean;
}
