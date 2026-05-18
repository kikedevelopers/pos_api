import { Injectable } from '@nestjs/common';

import {
  BulkArchiveProductsAction,
  type BulkArchiveResult,
} from './actions/bulk-archive-products.action';
import { BulkProcessProductsAction } from './actions/bulk-process-products.action';
import {
  BulkToggleShowInPosAction,
  type BulkToggleShowInPosResult,
} from './actions/bulk-toggle-show-in-pos.action';
import { CompareProductPricesAction } from './actions/compare-product-prices.action';
import { CreateProductAction, type ProductCreator } from './actions/create-product.action';
import { FindAllProductsAction } from './actions/find-all-products.action';
import { FindProductByIdAction } from './actions/find-product-by-id.action';
import { FindSupplierHistoryAction } from './actions/find-supplier-history.action';
import { GetProductSalesHistoryAction } from './actions/get-product-sales-history.action';
import {
  QuickCreateProductAction,
  type QuickProductCreator,
} from './actions/quick-create-product.action';
import { UpdateProductAction } from './actions/update-product.action';
import type { BulkProductsDto, BulkProductsResponseDto } from './dto/bulk-products.dto';
import type { CreateProductDto } from './dto/create-product.dto';
import type { InventoryQueryDto } from './dto/inventory-query.dto';
import type { PriceComparisonResponseDto } from './dto/price-comparison-response.dto';
import type { SalesHistoryResponseDto } from './dto/product-response.dto';
import type { QuickCreateProductDto } from './dto/quick-create-product.dto';
import type { SupplierHistoryResponseDto } from './dto/supplier-history-response.dto';
import type { UpdateProductDto } from './dto/update-product.dto';
import type { Product } from './entities/product.entity';

export type { ProductCreator } from './actions/create-product.action';
export type { QuickProductCreator } from './actions/quick-create-product.action';
export type { BulkArchiveResult } from './actions/bulk-archive-products.action';
export type { BulkToggleShowInPosResult } from './actions/bulk-toggle-show-in-pos.action';

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
    private readonly bulkArchiveProductsAction: BulkArchiveProductsAction,
    private readonly bulkToggleShowInPosAction: BulkToggleShowInPosAction,
    private readonly bulkProcessProductsAction: BulkProcessProductsAction,
    private readonly getProductSalesHistoryAction: GetProductSalesHistoryAction,
    private readonly quickCreateProductAction: QuickCreateProductAction,
    private readonly findSupplierHistoryAction: FindSupplierHistoryAction,
    private readonly compareProductPricesAction: CompareProductPricesAction,
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

  bulkArchive(ids: number[], companyId: number): Promise<BulkArchiveResult> {
    return this.bulkArchiveProductsAction.execute(ids, companyId);
  }

  bulkToggleShowInPos(
    ids: number[],
    showInPos: boolean,
    companyId: number,
  ): Promise<BulkToggleShowInPosResult> {
    return this.bulkToggleShowInPosAction.execute(ids, showInPos, companyId);
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

  quickCreate(
    dto: QuickCreateProductDto,
    companyId: number,
    createdBy: QuickProductCreator,
  ): Promise<Product> {
    return this.quickCreateProductAction.execute(dto, companyId, createdBy);
  }

  findSupplierHistory(
    productId: number,
    supplierId: number,
    companyId: number,
  ): Promise<SupplierHistoryResponseDto> {
    return this.findSupplierHistoryAction.execute(productId, supplierId, companyId);
  }

  comparePrices(productId: number, companyId: number): Promise<PriceComparisonResponseDto> {
    return this.compareProductPricesAction.execute(productId, companyId);
  }
}
