import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Datos de la company en el detalle del tenant.
 */
export class SuperadminTenantCompanyDto {
  @ApiProperty({ example: 8 })
  id!: number;

  @ApiProperty({ example: 'Surtidor La Esquina C.A.' })
  name!: string;

  @ApiPropertyOptional({ example: 'J-12345678-9', nullable: true })
  documentNumber!: string | null;

  @ApiPropertyOptional({ example: 'Av. Principal, Edif. Plaza, Piso 1', nullable: true })
  address!: string | null;

  @ApiPropertyOptional({ example: 'contacto@minegocio.com', nullable: true })
  email!: string | null;

  @ApiPropertyOptional({ example: '+58 412-1234567', nullable: true })
  phoneNumber!: string | null;

  @ApiProperty({ example: 'web', description: "Origen: 'web' | 'offline_migration'." })
  origin!: string;

  @ApiProperty({ example: '2026-05-12T14:30:00.000Z' })
  createdAt!: string;
}

/**
 * Datos del owner en el detalle del tenant.
 */
export class SuperadminTenantOwnerDto {
  @ApiProperty({ example: 9 })
  id!: number;

  @ApiProperty({ example: 'Kike Dev', description: 'Nombre + apellido.' })
  name!: string;

  @ApiProperty({ example: 'owner@empresa.com' })
  email!: string;
}

/**
 * Suscripción en el detalle del tenant. `null` si la company aún no tiene fila
 * de suscripción (caso atípico: el registro normal siempre la crea).
 */
export class SuperadminTenantSubscriptionDto {
  @ApiProperty({ example: '2026-05-12T14:30:00.000Z' })
  startedAt!: string;

  @ApiProperty({ example: '2026-05-22T14:30:00.000Z' })
  expiresAt!: string;

  @ApiProperty({ example: true, description: 'expiresAt > now al momento de la consulta.' })
  active!: boolean;
}

/**
 * Conteos por dominio, scoped por company_id. Cada número es un COUNT directo
 * sobre la tabla correspondiente.
 */
export class SuperadminTenantCountsDto {
  @ApiProperty({ example: 1240, description: 'sale_invoices.' })
  ventas!: number;

  @ApiProperty({ example: 312, description: 'purchases.' })
  compras!: number;

  @ApiProperty({ example: 540, description: 'customers.' })
  clientes!: number;

  @ApiProperty({ example: 890, description: 'products.' })
  productos!: number;

  @ApiProperty({ example: 47, description: 'suppliers.' })
  proveedores!: number;

  @ApiProperty({ example: 205, description: 'expenses.' })
  gastos!: number;
}

/**
 * Respuesta de `GET /superadmin/tenants/:companyId`.
 */
export class SuperadminTenantDetailDto {
  @ApiProperty({ type: SuperadminTenantCompanyDto })
  company!: SuperadminTenantCompanyDto;

  @ApiProperty({ type: SuperadminTenantOwnerDto, nullable: true })
  owner!: SuperadminTenantOwnerDto | null;

  @ApiPropertyOptional({ type: SuperadminTenantSubscriptionDto, nullable: true })
  subscription!: SuperadminTenantSubscriptionDto | null;

  @ApiProperty({ type: SuperadminTenantCountsDto })
  counts!: SuperadminTenantCountsDto;
}
