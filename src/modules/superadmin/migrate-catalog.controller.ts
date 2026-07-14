import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';

import { Public } from '@/common/decorators/public.decorator';
import { AdminSignatureGuard } from '@/common/guards/admin-signature.guard';

import { MigrateCatalogAction } from './actions/migrate-catalog.action';
import { MigrateCatalogDto } from './dto/migrate-catalog.dto';
import type { MigrateCatalogResult } from './internal/migrate-catalog.helpers';

/**
 * Endpoint DEDICADO de migración de catálogo Mongo → pos_api cloud, consumido
 * por el panel kdevs-admin (tab "Migrar datos").
 *
 * Va en un controller PROPIO (no en `SuperadminController`) porque su
 * autenticación es distinta: `AdminSignatureGuard` (par `ADMIN_SIGNING_*`,
 * hashea BODY VACÍO `''`, igual que `migration-import`), NO
 * `SuperadminSignatureGuard` (que hashea el body real). `@Public()` salta el
 * `JwtAuthGuard` global; la firma Ed25519 es la única credencial.
 *
 * La integridad del body viaja por HTTPS (el mensaje firmado no incluye su
 * hash), consistente con `importMigrationZip`. El body puede ser grande
 * (miles de productos); `main.ts` ya sube el límite del body parser JSON.
 */
@ApiTags('superadmin')
@Public()
@UseGuards(AdminSignatureGuard)
@Controller('superadmin')
export class MigrateCatalogController {
  constructor(private readonly migrateCatalogAction: MigrateCatalogAction) {}

  @Post('tenants/:companyId/migrate-catalog')
  @Public()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Migrar catálogo (productos+clientes+categorías+empaques) Mongo → company destino',
    description:
      'Firmado con AdminSignatureGuard (Ed25519, body-hash vacío). Inserta ' +
      'idempotente por nombre (lower(btrim(name))), preservando la jerarquía ' +
      'base↔presentación, dentro de una transacción con SAVEPOINT por fila.',
  })
  @ApiParam({ name: 'companyId', type: Number, description: 'Id de la company destino.' })
  @ApiResponse({ status: HttpStatus.CREATED, description: 'Resumen de la migración.' })
  @ApiResponse({ status: HttpStatus.BAD_REQUEST, description: 'La company destino no existe.' })
  @ApiResponse({ status: HttpStatus.UNAUTHORIZED, description: 'Firma inválida o ausente.' })
  async migrate(
    @Param('companyId', ParseIntPipe) companyId: number,
    @Body() dto: MigrateCatalogDto,
  ): Promise<MigrateCatalogResult> {
    // `MigrateCatalogDto` es estructuralmente asignable a `MigrateCatalogBody`
    // (products/customers/meta con los mismos shapes) — sin cast.
    return this.migrateCatalogAction.execute(companyId, dto);
  }
}
