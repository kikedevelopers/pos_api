import { ApiProperty } from '@nestjs/swagger';
import { IsInt, IsNotEmpty, IsString, MaxLength, Min } from 'class-validator';

/**
 * Cuerpo de `POST /agreements/accept`. El usuario/company se derivan del JWT,
 * nunca del payload (anti-IDOR).
 */
export class AcceptAgreementDto {
  @ApiProperty({
    example: 'whatsapp_liability_disclaimer',
    maxLength: 100,
    description: 'Clave estable del acuerdo que se acepta.',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  key!: string;

  @ApiProperty({
    example: 1,
    minimum: 1,
    description: 'Versión del acuerdo que el usuario está aceptando.',
  })
  @IsInt()
  @Min(1)
  version!: number;
}
