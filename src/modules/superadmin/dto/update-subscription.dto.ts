import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsInt, IsISO8601, Max, Min, ValidateIf } from 'class-validator';

/**
 * Body de `PATCH /superadmin/tenants/:companyId/subscription`.
 *
 * Exactamente UNO de los dos campos:
 *   - `expiresAt`  → fija la fecha de vencimiento (ISO 8601).
 *   - `extendDays` → suma N días a `max(now, expiresAt actual)`.
 *
 * La regla "uno u otro" se valida con `@ValidateIf`: cada campo es requerido
 * solo cuando el otro está ausente, de modo que enviar ambos o ninguno falla.
 */
export class UpdateSubscriptionDto {
  @ApiPropertyOptional({
    example: '2026-12-31T23:59:59.000Z',
    description: 'Nueva fecha de vencimiento (ISO 8601). Excluyente con extendDays.',
  })
  @ValidateIf((o: UpdateSubscriptionDto) => o.extendDays === undefined)
  @IsISO8601()
  expiresAt?: string;

  @ApiPropertyOptional({
    example: 30,
    description:
      'Días a sumar sobre max(now, expiresAt actual). Excluyente con expiresAt. Rango 1..3650.',
  })
  @ValidateIf((o: UpdateSubscriptionDto) => o.expiresAt === undefined)
  @IsInt()
  @Min(1)
  @Max(3650)
  extendDays?: number;
}
