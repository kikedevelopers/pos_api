import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Un nivel de precio público de un producto. SOLO el precio de venta — nunca
 * costo, ganancia ni margen (datos internos del negocio que jamás salen al
 * catálogo público).
 */
export class CatalogPriceDto {
  @ApiProperty({ example: 'Detal' })
  name!: string;

  @ApiProperty({ example: 12000 })
  price!: number;
}

/** Un producto tal como lo ve un cliente anónimo en el catálogo. */
export class CatalogProductDto {
  @ApiProperty({ example: 1234 })
  id!: number;

  @ApiProperty({ example: 'Café de origen 500g' })
  name!: string;

  @ApiPropertyOptional({ example: 'Tueste medio, notas a chocolate', nullable: true })
  description!: string | null;

  @ApiPropertyOptional({ example: 'Café', nullable: true })
  category!: string | null;

  /**
   * URL (RELATIVA al API, p. ej. `/product-images/serve?...`) de la imagen del
   * producto, o `null` si no tiene. El cliente la antepone con la base del API.
   */
  @ApiPropertyOptional({ example: '/product-images/serve?o=...', nullable: true })
  image_url!: string | null;

  /**
   * El negocio marcó el producto como fuera de stock: sigue visible en el
   * catálogo pero debe mostrarse atenuado y como "No disponible".
   */
  @ApiProperty({ example: false })
  out_of_stock!: boolean;

  @ApiProperty({ type: [CatalogPriceDto] })
  prices!: CatalogPriceDto[];
}

/** Datos públicos del negocio dueño del catálogo. */
export class CatalogBusinessDto {
  @ApiProperty({ example: 'Esencia & Grano' })
  name!: string;

  @ApiProperty({ example: 'esenciaygrano' })
  slug!: string;

  /**
   * Preferencia de presentación: si el catálogo se muestra agrupado por
   * categoría (con sidebar de navegación) o en una cuadrícula plana.
   */
  @ApiProperty({ example: false })
  group_by_category!: boolean;

  /**
   * URL (RELATIVA al API) de la imagen de portada del hero, o `null` si el
   * negocio no subió una → la landing muestra el hero por defecto.
   */
  @ApiPropertyOptional({ example: '/product-images/serve?o=...', nullable: true })
  cover_image_url!: string | null;
}

/** Respuesta de `GET /catalog/:slug`. */
export class PublicCatalogResponseDto {
  @ApiProperty({ type: CatalogBusinessDto })
  business!: CatalogBusinessDto;

  @ApiProperty({ type: [CatalogProductDto] })
  products!: CatalogProductDto[];

  @ApiProperty({ example: 42 })
  count!: number;
}
