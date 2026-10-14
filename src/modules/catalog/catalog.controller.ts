import { Controller, Get, HttpStatus, Param } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';

import { Public } from '@/common/decorators/public.decorator';

import { GetPublicCatalogAction } from './actions/get-public-catalog.action';
import { PublicCatalogResponseDto } from './dto/public-catalog-response.dto';

/**
 * Catálogo público del negocio, consumido por la landing (`placepos_lp`) en
 * `/catalog/<slug>`. SIN autenticación (`@Public()`): lo ven los clientes del
 * comercio con solo el enlace.
 *
 * Como es anónimo y cacheable por bots, lo acotamos con un throttle propio más
 * estricto que el global (defensa básica contra scraping/abuso).
 */
@ApiTags('catalog')
@Controller('catalog')
export class CatalogController {
  constructor(private readonly getPublicCatalog: GetPublicCatalogAction) {}

  @Public()
  @Get(':slug')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @ApiOperation({ summary: 'Catálogo público de un negocio por su slug' })
  @ApiParam({ name: 'slug', type: 'string', example: 'esenciaygrano' })
  @ApiResponse({ status: HttpStatus.OK, type: PublicCatalogResponseDto })
  @ApiResponse({ status: HttpStatus.NOT_FOUND, description: 'Catálogo no encontrado o no publicado' })
  async getCatalog(@Param('slug') slug: string): Promise<PublicCatalogResponseDto> {
    return this.getPublicCatalog.execute(slug);
  }
}
