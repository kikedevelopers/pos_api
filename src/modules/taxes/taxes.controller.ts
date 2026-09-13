import { Controller, Get, HttpStatus, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

import { ElectronicBillingGuard } from '@/common/guards/electronic-billing.guard';
import { Roles } from '@/common/decorators/roles.decorator';

import { TaxRateResponseDto, toTaxRateResponseDto } from './dto/tax-rate-response.dto';
import { TaxesService } from './taxes.service';

/**
 * Endpoints `/tax-rates`. Catálogo GLOBAL de tarifas de IVA (Colombia), de solo
 * lectura. Lo consume el formulario de producto cuando el negocio es facturador
 * electrónico. Cualquier usuario autenticado de la company puede leerlo.
 */
@ApiTags('tax-rates')
@ApiBearerAuth('bearer')
@Controller('tax-rates')
@Roles('owner', 'manager', 'employee')
// El catálogo solo se sirve a negocios con FE activa AHORA (validado contra la
// BD). Un negocio al que se le apagó la FE recibe 403 aunque su front siga
// creyendo que es facturador.
@UseGuards(ElectronicBillingGuard)
export class TaxesController {
  constructor(private readonly taxesService: TaxesService) {}

  @Get()
  @ApiOperation({ summary: 'Listar las tarifas de IVA activas del catálogo (global).' })
  @ApiResponse({ status: HttpStatus.OK, type: [TaxRateResponseDto] })
  @ApiResponse({ status: HttpStatus.UNAUTHORIZED, description: 'Token ausente o inválido' })
  async findAll(): Promise<TaxRateResponseDto[]> {
    const taxes = await this.taxesService.findAllActive();
    return taxes.map(toTaxRateResponseDto);
  }
}
