import { PartialType } from '@nestjs/swagger';

import { CreatePackagingDto } from './create-packaging.dto';

/**
 * Payload de `PUT /packagings/:id`.
 *
 * PartialType para idempotencia (PUT con body vacío no rompe). PlacePos
 * exige los dos campos pero el service tolera ausencias (no nullifica
 * columnas no enviadas). Esto es divergencia ligera y backwards-compatible:
 * el frontend siempre los manda; permitirlo opcional no rompe.
 */
export class UpdatePackagingDto extends PartialType(CreatePackagingDto) {}
