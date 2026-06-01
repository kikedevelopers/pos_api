import { ApiProperty } from '@nestjs/swagger';

/**
 * Resultado de `DELETE /superadmin/tenants/:companyId`. El borrado de la fila
 * `companies` barre TODO el tenant por cascada (irreversible).
 */
export class SuperadminDeleteTenantResponseDto {
  @ApiProperty({ example: true })
  success!: boolean;

  @ApiProperty({ example: 8 })
  deletedCompanyId!: number;
}
