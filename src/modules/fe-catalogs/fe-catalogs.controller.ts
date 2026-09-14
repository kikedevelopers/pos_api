import { Controller, Get, HttpStatus, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';

import { Roles } from '@/common/decorators/roles.decorator';
import { ElectronicBillingGuard } from '@/common/guards/electronic-billing.guard';

import {
  type FeMunicipality,
  type FeSimpleCatalogs,
  FeCatalogsService,
} from './fe-catalogs.service';

/**
 * Endpoints `/fe/catalogs`. Proxy con caché de los catálogos de Facturación
 * Electrónica que viven en el API externo (APIDIAN): tipos de documento,
 * organización, régimen, responsabilidades y municipios. Los consume el
 * formulario de cliente cuando el negocio es facturador electrónico.
 *
 * Gateado por `ElectronicBillingGuard`: un negocio al que se le apagó la FE
 * recibe 403 aunque su front (SPA) siga creyendo que es facturador.
 */
@ApiTags('fe-catalogs')
@ApiBearerAuth('bearer')
@Controller('fe/catalogs')
@Roles('owner', 'manager', 'employee')
@UseGuards(ElectronicBillingGuard)
export class FeCatalogsController {
  constructor(private readonly feCatalogsService: FeCatalogsService) {}

  @Get()
  @ApiOperation({
    summary: 'Catálogos simples de FE (tipos de documento, organización, régimen, responsabilidad).',
  })
  @ApiResponse({ status: HttpStatus.OK })
  @ApiResponse({ status: HttpStatus.FORBIDDEN, description: 'El negocio no tiene FE activa' })
  @ApiResponse({ status: HttpStatus.SERVICE_UNAVAILABLE, description: 'APIDIAN no disponible' })
  async getSimpleCatalogs(): Promise<FeSimpleCatalogs> {
    return this.feCatalogsService.getSimpleCatalogs();
  }

  @Get('municipalities')
  @ApiOperation({ summary: 'Buscar municipios (ciudad, departamento) para el combobox.' })
  @ApiQuery({ name: 'search', required: false, description: 'Filtra por nombre o departamento.' })
  @ApiQuery({
    name: 'id',
    required: false,
    description: 'Resuelve un municipio puntual por id (para el modo edición).',
  })
  @ApiResponse({ status: HttpStatus.OK })
  async searchMunicipalities(
    @Query('search') search?: string,
    @Query('id') id?: string,
  ): Promise<FeMunicipality[]> {
    // `?id=` resuelve un municipio concreto (el guardado en el cliente); tiene
    // prioridad sobre `search`. Un id inválido/no numérico devuelve vacío.
    if (id !== undefined) {
      const numericId = Number(id);
      if (!Number.isInteger(numericId) || numericId <= 0) {
        return [];
      }
      const municipality = await this.feCatalogsService.findMunicipalityById(numericId);
      return municipality ? [municipality] : [];
    }
    return this.feCatalogsService.searchMunicipalities(search);
  }
}
