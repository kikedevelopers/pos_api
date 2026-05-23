import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { ArrayMaxSize, ArrayUnique, IsArray, IsIn } from 'class-validator';

import { SELECTABLE_MODULES, type SelectableModule } from '../internal/manifest.types';

/**
 * Body del endpoint `POST /migration-import`. Multipart con:
 *
 *   - `file`: archivo ZIP (max ~50 MB) — manejado por `FileInterceptor`.
 *   - `selectedModules`: string JSON array, ej. `'["catalog","sales"]'`.
 *
 * `selectedModules` llega como string (no JSON nativo porque multipart no
 * soporta tipos no-string). El `Transform` lo parsea ANTES de validar.
 */
export class MigrationImportDto {
  @ApiProperty({
    description: 'JSON array de módulos a importar. Las dependencias se resuelven automáticamente.',
    example: ['catalog', 'customers', 'sales'],
    isArray: true,
    enum: SELECTABLE_MODULES,
  })
  @Transform(({ value }: { value: unknown }): unknown => {
    if (Array.isArray(value)) {
      return value as unknown[];
    }
    if (typeof value !== 'string') {
      return value;
    }
    try {
      return JSON.parse(value) as unknown;
    } catch {
      return value;
    }
  })
  @IsArray()
  @ArrayMaxSize(SELECTABLE_MODULES.length)
  @ArrayUnique()
  @IsIn(SELECTABLE_MODULES, { each: true })
  selectedModules!: SelectableModule[];
}
