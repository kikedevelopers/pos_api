import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

/**
 * Payload de `PUT /purchases/:id/receive`. Espejo PlacePos `ReceivePurchaseBody`.
 */
export class ReceivePurchaseDto {
  @ApiProperty({ example: 'Transportes Express SAS', maxLength: 100 })
  @IsString()
  @IsNotEmpty({ message: 'La transportadora es obligatoria' })
  @MaxLength(100)
  carrier_name!: string;

  @ApiProperty({ example: 'Juan Pérez', maxLength: 100 })
  @IsString()
  @IsNotEmpty({ message: 'El receptor es obligatorio' })
  @MaxLength(100)
  received_by!: string;
}
