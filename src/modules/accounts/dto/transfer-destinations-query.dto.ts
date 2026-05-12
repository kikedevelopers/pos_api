import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsString, Min } from 'class-validator';

import { TRANSFER_ACCOUNT_TYPES, type TransferAccountType } from './transfer.dto';

/**
 * Query de `GET /accounts/transfer-destinations?sourceType=wallet&sourceId=1`.
 * Espeja PlacePos.
 */
export class TransferDestinationsQueryDto {
  @ApiProperty({ enum: TRANSFER_ACCOUNT_TYPES, example: 'wallet' })
  @IsString()
  @IsIn([...TRANSFER_ACCOUNT_TYPES], { message: 'sourceType debe ser wallet o bank' })
  sourceType!: TransferAccountType;

  @ApiProperty({ example: 1 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  sourceId!: number;
}
