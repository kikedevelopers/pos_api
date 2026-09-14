import { ApiProperty } from '@nestjs/swagger';

/** Respuesta de `POST /inventory/:id/image`. */
export class ProductImageResponseDto {
  @ApiProperty({ example: 42 })
  product_id!: number;

  @ApiProperty({
    example: 'inventory_items/8/42-9f3c1a7b2d4e5f60.jpg',
    description: 'Ruta del objeto en el bucket. El cliente NO la usa para pintar: usa `image_url`.',
  })
  image!: string;

  @ApiProperty({
    example: 'https://storage.googleapis.com/…?X-Goog-Signature=…',
    description: 'URL firmada temporal. Caduca; se renueva sola en cada listado.',
  })
  image_url!: string;
}

/** Respuesta de `POST /inventory/:id/image/remove`. */
export class RemoveProductImageResponseDto {
  @ApiProperty({ example: 42 })
  product_id!: number;

  @ApiProperty({
    example: true,
    description: 'false = el producto ya no tenía imagen (la operación es idempotente).',
  })
  removed!: boolean;
}

/** Respuesta de `GET /inventory/image-settings`. */
export class ProductImageSettingsResponseDto {
  @ApiProperty({
    example: true,
    description: 'false = este servidor no tiene bucket configurado; el front oculta el campo.',
  })
  enabled!: boolean;

  @ApiProperty({ example: 2 })
  max_size_mb!: number;

  @ApiProperty({ example: 800 })
  recommended_width!: number;

  @ApiProperty({ example: 800 })
  recommended_height!: number;

  @ApiProperty({ example: ['jpg', 'png', 'webp'] })
  accepted_formats!: string[];
}
