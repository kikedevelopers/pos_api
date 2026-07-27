import { ApiProperty } from '@nestjs/swagger';

import type { TenantInventorySummary } from '../actions/get-tenant-inventory.action';
import type { ClearTenantInventoryResult } from '../actions/clear-tenant-inventory.action';

/** Resumen del inventario de un tenant (panel superadmin). */
export class SuperadminTenantInventoryDto {
  @ApiProperty({ description: 'Productos activos (lo que el cliente ve en su inventario)' })
  active!: number;

  @ApiProperty({ description: 'Productos base (sin padre) dentro de los activos' })
  bases!: number;

  @ApiProperty({ description: 'Presentaciones dentro de los activos' })
  presentations!: number;

  @ApiProperty({ description: 'Productos ya archivados' })
  archived!: number;

  @ApiProperty({ description: 'Se borrarían físicamente al vaciar (sin historial de negocio)' })
  deletable!: number;

  @ApiProperty({
    description: 'Se archivarían al vaciar (su árbol tiene ventas/compras/movimientos)',
  })
  protectable!: number;

  @ApiProperty({ description: 'Valor del inventario activo a costo' })
  stockValue!: number;

  @ApiProperty({ description: 'Categorías activas (no se tocan al vaciar)' })
  categories!: number;

  @ApiProperty({ description: 'Empaques activos (no se tocan al vaciar)' })
  packagings!: number;
}

export const toSuperadminTenantInventoryDto = (
  summary: TenantInventorySummary,
): SuperadminTenantInventoryDto => ({ ...summary });

/** Resultado de vaciar el inventario. */
export class SuperadminClearInventoryResponseDto {
  @ApiProperty({ description: 'Productos borrados físicamente' })
  deleted!: number;

  @ApiProperty({ description: 'Productos archivados (conservan su historial)' })
  archived!: number;

  @ApiProperty({ description: 'Productos activos que quedan (debe ser 0)' })
  remaining!: number;
}

export const toSuperadminClearInventoryResponseDto = (
  result: ClearTenantInventoryResult,
): SuperadminClearInventoryResponseDto => ({ ...result });
