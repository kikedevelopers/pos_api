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

import { HistoryQueryDto } from './dto/history-query.dto';
import { PriceHistoryEntryDto, toPriceHistoryEntryDto } from './dto/price-history-response.dto';
import { ProductHistoryService } from './product-history.service';

/**
 * Endpoint `GET /product-prices/:id/price-history`. Ruta absoluta espejo
 * PlacePos.
 */
@ApiTags('product-history')
@ApiBearerAuth('bearer')
@Controller('product-prices')
@Roles('owner', 'manager', 'employee')
export class ProductPriceHistoryController {
  constructor(private readonly productHistoryService: ProductHistoryService) {}

  @Get(':id/price-history')
  @ApiOperation({
    summary: 'Historial de precio del product_price',
    description: 'JOIN con cost_history para traer purchase_id + event_type.',
  })
  @ApiParam({ name: 'id', type: 'integer', example: 7 })
  @ApiQuery({ name: 'limit', required: false, type: Number, example: 20 })
  @ApiResponse({ status: HttpStatus.OK, type: [PriceHistoryEntryDto] })
  @ApiResponse({ status: HttpStatus.BAD_REQUEST, description: 'id inválido' })
  async findPriceHistory(
    @Param('id', ParseIntPipe) id: number,
    @Query() query: HistoryQueryDto,
    @CurrentCompany() companyId: number,
  ): Promise<PriceHistoryEntryDto[]> {
    const items = await this.productHistoryService.findPriceHistory(id, companyId, query.limit);
    return items.map((it) =>
      toPriceHistoryEntryDto(it.entry, {
        purchase_id: it.purchase_id,
        event_type: it.event_type,
      }),
    );
  }
}
