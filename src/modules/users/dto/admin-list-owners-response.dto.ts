import { ApiProperty } from '@nestjs/swagger';

import { AdminOwnerResponseDto } from './admin-owner-response.dto';

/**
 * Respuesta paginada de `GET /admin/users/owners`.
 */
export class AdminListOwnersResponseDto {
  @ApiProperty({ type: [AdminOwnerResponseDto] })
  owners!: AdminOwnerResponseDto[];

  @ApiProperty({ example: 128, description: 'Total de owners que matchean (sin paginar).' })
  total!: number;

  @ApiProperty({ example: 50 })
  limit!: number;

  @ApiProperty({ example: 0 })
  offset!: number;
}
