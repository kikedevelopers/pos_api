import { Injectable } from '@nestjs/common';

import { ArchiveProductAction } from './actions/archive-product.action';
import { BulkProcessProductsAction } from './actions/bulk-process-products.action';
import { CreateProductAction, type ProductCreator } from './actions/create-product.action';
import { FindAllProductsAction } from './actions/find-all-products.action';
import { FindProductByIdAction } from './actions/find-product-by-id.action';
import { GetProductSalesHistoryAction } from './actions/get-product-sales-history.action';
import { ToggleShowInPosAction } from './actions/toggle-show-in-pos.action';
import { UpdateProductAction } from './actions/update-product.action';
import type { BulkProductsDto, BulkProductsResponseDto } from './dto/bulk-products.dto';
import type { CreateProductDto } from './dto/create-product.dto';
import type { InventoryQueryDto } from './dto/inventory-query.dto';
import type { SalesHistoryResponseDto } from './dto/product-response.dto';
import type { UpdateProductDto } from './dto/update-product.dto';
import type { Product } from './entities/product.entity';

export type { ProductCreator } from './actions/create-product.action';

/**
 * Facade delgado del dominio `products`. ZERO lógica de negocio — solo
 * delega a la action correspondiente. Patrón §3.1 del CLAUDE.md.
 */
@Injectable()
export class ProductsService {
  constructor(
    private readonly findAllProductsAction: FindAllProductsAction,
    private readonly findProductByIdAction: FindProductByIdAction,
    private readonly createProductAction: CreateProductAction,
    private readonly updateProductAction: UpdateProductAction,
    private readonly archiveProductAction: ArchiveProductAction,
    private readonly toggleShowInPosAction: ToggleShowInPosAction,
    private readonly bulkProcessProductsAction: BulkProcessProductsAction,
    private readonly getProductSalesHistoryAction: GetProductSalesHistoryAction,
  ) {}

  findAll(companyId: number, query: InventoryQueryDto): Promise<Product[]> {
    return this.findAllProductsAction.execute(companyId, query);
  }

  findById(id: number, companyId: number): Promise<Product | null> {
    return this.findProductByIdAction.execute(id, companyId);
  }

  create(dto: CreateProductDto, companyId: number, createdBy: ProductCreator): Promise<Product> {
    return this.createProductAction.execute(dto, companyId, createdBy);
  }

  update(
    id: number,
    dto: UpdateProductDto,
    companyId: number,
    actor: ProductCreator,
  ): Promise<Product> {
    return this.updateProductAction.execute(id, dto, companyId, actor);
  }

  archive(id: number, companyId: number): Promise<void> {
    return this.archiveProductAction.execute(id, companyId);
  }

  toggleShowInPos(id: number, showInPos: boolean, companyId: number): Promise<void> {
    return this.toggleShowInPosAction.execute(id, showInPos, companyId);
  }

  bulkProcess(
    dto: BulkProductsDto,
    companyId: number,
    actor: ProductCreator,
  ): Promise<BulkProductsResponseDto> {
    return this.bulkProcessProductsAction.execute(dto.items, companyId, actor);
  }

  getSalesHistory(productId: number, companyId: number): Promise<SalesHistoryResponseDto> {
    return this.getProductSalesHistoryAction.execute(productId, companyId);
  }
}
