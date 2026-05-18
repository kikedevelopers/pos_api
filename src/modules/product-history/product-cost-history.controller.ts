import { Controller, Get, HttpStatus, Param, ParseIntPipe, Query } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';

import { CurrentCompany } from '@/common/decorators/current-company.decorator';
import { Roles } from '@/common/decorators/roles.decorator';

import { CostHistoryEntryDto, toCostHistoryEntryDto } from './dto/cost-history-response.dto';
import { HistoryQueryDto } from './dto/history-query.dto';
import { ProductHistoryService } from './product-history.service';

/**
 * Endpoint `GET /products/:id/cost-history`. **Ruta absoluta** —
 * intencionalmente montada en `/products` (no en `/inventory`) para
 * coincidir byte-por-byte con el contrato PlacePos.
 *
 * No colisiona con `ProductsController` porque ese se monta en
 * `/inventory`. Si en el futuro se moviera Products a `/products`, este
 * controller debe declararse en el mismo módulo o reorganizarse.
 */
@ApiTags('product-history')
@ApiBearerAuth('bearer')
@Controller('products')
@Roles('owner', 'manager', 'employee')
export class ProductCostHistoryController {
  constructor(private readonly productHistoryService: ProductHistoryService) {}

  @Get(':id/cost-history')
  @ApiOperation({
    summary: 'Historial de costo del producto',
    description: 'Default limit=20, máximo 100. Fase 2A: tabla aún vacía hasta Fase 5+.',
  })
  @ApiParam({ name: 'id', type: 'integer', example: 42 })
  @ApiQuery({ name: 'limit', required: false, type: Number, example: 20 })
  @ApiResponse({ status: HttpStatus.OK, type: [CostHistoryEntryDto] })
  @ApiResponse({ status: HttpStatus.BAD_REQUEST, description: 'id inválido' })
  async findCostHistory(
    @Param('id', ParseIntPipe) id: number,
    @Query() query: HistoryQueryDto,
    @CurrentCompany() companyId: number,
  ): Promise<CostHistoryEntryDto[]> {
    const items = await this.productHistoryService.findCostHistory(id, companyId, query.limit);
    return items.map((it) => toCostHistoryEntryDto(it.entry, it.purchase_number));
  }
}
