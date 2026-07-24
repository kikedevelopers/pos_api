import { ApiProperty } from '@nestjs/swagger';

import { AgreementAcceptance } from '../entities/agreement-acceptance.entity';

/**
 * Aceptación tal como la consume el front (camelCase). No expone company_id ni
 * user_id (el front solo necesita saber qué acuerdo/versión aceptó el usuario
 * autenticado).
 */
export class AgreementAcceptanceResponseDto {
  @ApiProperty({ example: 'whatsapp_liability_disclaimer' })
  agreementKey!: string;

  @ApiProperty({ example: 1 })
  version!: number;

  @ApiProperty({ example: '2026-07-24T17:30:00.000Z' })
  acceptedAt!: string;
}

export function toAgreementAcceptanceResponseDto(
  row: AgreementAcceptance,
): AgreementAcceptanceResponseDto {
  return {
    agreementKey: row.agreement_key,
    version: row.version,
    acceptedAt: row.accepted_at.toISOString(),
  };
}
