import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsDefined,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUrl,
  MaxLength,
  ValidateNested,
} from 'class-validator';

export class PushSubscriptionKeysDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  p256dh!: string;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  auth!: string;
}

/** `PushSubscription.toJSON()` del navegador. */
export class SavePushSubscriptionDto {
  @ApiProperty({ description: 'URL del servicio push del navegador.' })
  @IsUrl({ protocols: ['https'], require_protocol: true, require_tld: false })
  @MaxLength(2000)
  endpoint!: string;

  @ApiProperty({ type: PushSubscriptionKeysDto })
  @IsDefined()
  @ValidateNested()
  @Type(() => PushSubscriptionKeysDto)
  keys!: PushSubscriptionKeysDto;

  @ApiPropertyOptional({ description: 'Navegador/dispositivo (informativo).' })
  @IsOptional()
  @IsString()
  @MaxLength(300)
  user_agent?: string;
}

export class RemovePushSubscriptionDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @MaxLength(2000)
  endpoint!: string;
}
