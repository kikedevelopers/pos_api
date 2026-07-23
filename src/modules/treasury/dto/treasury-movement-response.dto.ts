import { ApiPropertyOptional } from '@nestjs/swagger';

import {
  FinancialMovementResponseDto,
  toFinancialMovementResponseDto,
} from '@/modules/financial-movements/dto/financial-movement-response.dto';
import { FinancialMovement } from '@/modules/financial-movements/entities/financial-movement.entity';

import type { NameResolver } from '../internal/resolve-account-names';
import { resolveMovementNames } from '../internal/resolve-account-names';

/**
 * Movimiento del feed unificado de tesorería: un `FinancialMovement` con el
 * nombre resuelto de su cuenta origen/destino (para que el cliente no tenga que
 * cruzar ids contra la lista de cuentas). Espejo del payload de
 * `placepos/.../treasury.routes.ts`.
 */
export class TreasuryMovementResponseDto extends FinancialMovementResponseDto {
  @ApiPropertyOptional({ example: 'Bancolombia', nullable: true })
  source_name!: string | null;

  @ApiPropertyOptional({ example: 'Caja de Juan Pérez', nullable: true })
  destination_name!: string | null;
}

export function toTreasuryMovementResponseDto(
  movement: FinancialMovement,
  resolve: NameResolver,
): TreasuryMovementResponseDto {
  const base = toFinancialMovementResponseDto(movement);
  const { source_name, destination_name } = resolveMovementNames(base, resolve);
  return { ...base, source_name, destination_name };
}
