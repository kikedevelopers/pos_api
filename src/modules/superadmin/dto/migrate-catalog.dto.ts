import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsArray, IsObject, IsOptional } from 'class-validator';

import type {
  MigrateCatalogCustomerInput,
  MigrateCatalogProductInput,
} from '../internal/migrate-catalog.helpers';

/**
 * Body de `POST /superadmin/tenants/:companyId/migrate-catalog`.
 *
 * Permisivo A PROPÓSITO (igual que `ImportTenantDto`): solo se valida el SHAPE
 * de primer nivel (`products`/`customers` son arrays, `meta` es un objeto
 * opcional). La validación FINA de cada producto/cliente (nombres, precios,
 * jerarquía base↔presentación, filtros de exclusión) vive en
 * `MigrateCatalogAction`, que es la autoridad del algoritmo y de la
 * idempotencia. No se usa `@ValidateNested` profundo porque el payload real
 * trae miles de filas heterogéneas mapeadas desde Mongo y la validación por
 * clase sería frágil y costosa.
 *
 * Nota sobre el `ValidationPipe` global (`whitelist: true`,
 * `forbidNonWhitelisted: true`): al declarar `products`/`customers`/`meta` como
 * propiedades de la clase, el pipe las conserva; el CONTENIDO de los arrays
 * (objetos planos, no instancias de clase) pasa intacto sin stripping, que es
 * justo lo que necesitamos.
 */
export class MigrateCatalogDto {
  @ApiPropertyOptional({
    description: 'Metadatos informativos del origen Mongo (email, negocio, id).',
  })
  @IsOptional()
  @IsObject()
  meta?: { email?: string; businessName?: string; mongoBusinessId?: string };

  @ApiProperty({
    description:
      'Productos mapeados desde Mongo. Bases (`parentSrcId=null`) y ' +
      'presentaciones (`parentSrcId=srcId del base`). Cada uno con 1..N precios.',
    isArray: true,
    type: Object,
  })
  @IsArray()
  products!: MigrateCatalogProductInput[];

  @ApiProperty({
    description: 'Clientes mapeados desde Mongo.',
    isArray: true,
    type: Object,
  })
  @IsArray()
  customers!: MigrateCatalogCustomerInput[];
}
