import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  ParseIntPipe,
  Post,
  Put,
  Query,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiBearerAuth,
  ApiBody,
  ApiConsumes,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';

import { CurrentCompany } from '@/common/decorators/current-company.decorator';
import { CurrentUser } from '@/common/decorators/current-user.decorator';
import { RequirePermission } from '@/common/decorators/require-permission.decorator';
import { Roles } from '@/common/decorators/roles.decorator';
import type { AuthUser } from '@/common/types/jwt-payload.type';
import { resolveMaxImageSizeBytes } from '@/config/product-images.config';
import {
  ProductImageResponseDto,
  ProductImageSettingsResponseDto,
  RemoveProductImageResponseDto,
} from '@/modules/product-images/dto/product-image-response.dto';
import { ProductImagesService } from '@/modules/product-images/product-images.service';

import {
  BulkArchiveProductsDto,
  BulkArchiveProductsResponseDto,
} from './dto/bulk-archive-products.dto';
import { BulkProductsDto, BulkProductsResponseDto } from './dto/bulk-products.dto';
import {
  BulkToggleShowInPosDto,
  BulkToggleShowInPosResponseDto,
} from './dto/bulk-toggle-show-in-pos.dto';
import { CreateProductDto } from './dto/create-product.dto';
import { InventoryQueryDto } from './dto/inventory-query.dto';
import { PriceComparisonResponseDto } from './dto/price-comparison-response.dto';
import {
  DuplicateProductResponseDto,
  ProductMinimalResponseDto,
  ProductResponseDto,
  SalesHistoryResponseDto,
  toProductResponseDto,
} from './dto/product-response.dto';
import { QuickCreateProductDto } from './dto/quick-create-product.dto';
import { SupplierHistoryResponseDto } from './dto/supplier-history-response.dto';
import { UpdateProductDto } from './dto/update-product.dto';
import { ProductsService } from './products.service';

/**
 * Endpoints de gestión de productos (catálogo). Espejo del contrato PlacePos
 * (`inventory.routes.ts`).
 *
 * Autorización:
 *   - GET → owner | manager | employee. Lectura del catálogo es operacional.
 *   - POST/PUT → owner | manager. El employee no muta el catálogo.
 *   - POST /quick → owner | manager | employee (PlacePos lo expone para
 *     que cualquier rol pueda crear durante una compra).
 *   - bulk → owner. Importaciones masivas son operación delicada.
 *   - PUT /archive, PUT /show-in-pos (bulk) → owner | manager.
 *
 * Multi-tenancy: `@CurrentCompany()` extrae el `company_id` del JWT.
 */
@ApiTags('inventory')
@ApiBearerAuth('bearer')
@Controller('inventory')
export class ProductsController {
  /**
   * Tope del archivo a nivel de TRANSPORTE.
   *
   * Multer guarda el archivo en MEMORIA, así que este número es lo que el API
   * llega a retener por petición concurrente. Se ata al límite real de negocio
   * (`PRODUCT_IMAGE_MAX_MB`) y no a un techo holgado: aceptar 32 MB en RAM para
   * después rechazar por pasarse de 2 MB es regalarle a cualquier cliente
   * autenticado 16× la memoria que la feature necesita.
   *
   * El margen de 1 KB existe para que el archivo que se pasa por poco muera en
   * `validateImageFile` —con el mensaje que dice cuántos MB se permiten— en vez
   * de en multer. Lo que se pase de ahí lo corta multer, que ya responde 413.
   */
  private static readonly MULTER_IMAGE_CEILING_BYTES = resolveMaxImageSizeBytes() + 1024;

  constructor(
    private readonly productsService: ProductsService,
    private readonly productImagesService: ProductImagesService,
  ) {}

  @Get()
  @Roles('owner', 'manager', 'employee')
  @ApiOperation({ summary: 'Listar productos de la company autenticada' })
  @ApiQuery({ name: 'search', required: false, type: String })
  @ApiQuery({ name: 'include_archived', required: false, type: Boolean })
  @ApiResponse({ status: HttpStatus.OK, type: [ProductResponseDto] })
  @ApiResponse({ status: HttpStatus.UNAUTHORIZED, description: 'Token ausente o inválido' })
  async findAll(
    @Query() query: InventoryQueryDto,
    @CurrentCompany() companyId: number,
  ): Promise<ProductResponseDto[]> {
    const products = await this.productsService.findAll(companyId, query);
    // Construimos un mapa parent_id -> stock para que los hijos resuelvan
    // su `stock_display` contra el stock del padre (espejo PlacePos
    // `normalizeChildProduct`). Los padres ya están en el listado.
    const parentStockById = new Map<string, number>();
    for (const product of products) {
      if (product.parent_id === null || product.parent_id === undefined) {
        parentStockById.set(product.id, Number(product.stock));
      }
    }
    const dtos = products.map((p) => {
      const parentStock =
        p.parent_id !== null && p.parent_id !== undefined
          ? (parentStockById.get(p.parent_id) ?? null)
          : null;
      return toProductResponseDto(p, parentStock);
    });
    // Las URLs firmadas se resuelven en UN lote contra el caché en memoria: sin
    // esto, un catálogo con foto firmaría una URL por producto en cada refresco
    // y agotaría la cuota de firma de Google.
    return this.attachImageUrls(dtos, companyId);
  }

  /**
   * `GET /inventory/image-settings` — Límites reales de la imagen de producto.
   *
   * El front lo usa para dos cosas: mostrar el tope y las dimensiones sugeridas
   * al usuario, y saber si debe pintar el campo (`enabled: false` cuando el
   * servidor no tiene bucket). Así el límite se declara UNA vez, en el servidor
   * que de verdad lo aplica, y el formulario nunca promete algo que el backend
   * va a rechazar.
   *
   * Va antes de `:id` por el orden de matching del router.
   */
  @Get('image-settings')
  @Roles('owner', 'manager', 'employee')
  @ApiOperation({ summary: 'Límites y recomendaciones para la imagen de un item' })
  @ApiResponse({ status: HttpStatus.OK, type: ProductImageSettingsResponseDto })
  getImageSettings(): ProductImageSettingsResponseDto {
    return this.productImagesService.getSettings();
  }

  /**
   * Bulk debe ir ANTES de `:id` para evitar conflicto de matching del router.
   */
  @Post('bulk')
  @Roles('owner')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Procesar batch de productos (importación)',
    description:
      'Por cada item: si trae SKU o código de barras, busca un producto activo de la company ' +
      'por (sku_code OR bar_code) → UPDATE; si no existe o no trae código → CREATE. ' +
      'category es el NOMBRE (find-or-create scoped company). Aislado por company_id.',
  })
  @ApiBody({ type: BulkProductsDto })
  @ApiResponse({ status: HttpStatus.OK, type: BulkProductsResponseDto })
  @ApiResponse({ status: HttpStatus.BAD_REQUEST, description: 'Payload inválido' })
  @ApiResponse({ status: HttpStatus.UNAUTHORIZED, description: 'Token ausente o inválido' })
  @ApiResponse({ status: HttpStatus.FORBIDDEN, description: 'Rol distinto a owner' })
  async bulk(
    @Body() dto: BulkProductsDto,
    @CurrentCompany() companyId: number,
    @CurrentUser() currentUser: AuthUser,
  ): Promise<BulkProductsResponseDto> {
    return this.productsService.bulkProcess(dto, companyId, {
      id: currentUser.user_id,
      fullName: `${currentUser.name} ${currentUser.lastname}`.trim(),
    });
  }

  /**
   * `POST /inventory/quick` — Creación rápida desde compras. Espejo PlacePos.
   *
   * Genera Product mínimo (`is_purchasable = true`, `show_in_pos = false`)
   * con un único ProductPrice cuyo `sale_price = cost` (profit/margin = 0).
   */
  @Post('quick')
  @HttpCode(HttpStatus.CREATED)
  @Roles('owner', 'manager', 'employee')
  @ApiOperation({
    summary: 'Crear producto mínimo desde el módulo de compras',
    description:
      'Crea Product SIMPLE con un único ProductPrice cuyo sale_price = cost. show_in_pos = false.',
  })
  @ApiBody({ type: QuickCreateProductDto })
  @ApiResponse({ status: HttpStatus.CREATED, type: ProductResponseDto })
  @ApiResponse({ status: HttpStatus.BAD_REQUEST, description: 'Payload inválido o duplicado' })
  @ApiResponse({ status: HttpStatus.NOT_FOUND, description: 'packaging_id inválido' })
  async quickCreate(
    @Body() dto: QuickCreateProductDto,
    @CurrentCompany() companyId: number,
    @CurrentUser() currentUser: AuthUser,
  ): Promise<ProductResponseDto> {
    const product = await this.productsService.quickCreate(dto, companyId, {
      id: currentUser.user_id,
      fullName: `${currentUser.name} ${currentUser.lastname}`.trim(),
    });
    return toProductResponseDto(product);
  }

  /**
   * `PUT /inventory/archive` — Bulk archive de productos. Espejo PlacePos.
   * Reemplaza al endpoint single `PUT /:id/archive` (que no existe en PlacePos).
   */
  @Put('archive')
  @HttpCode(HttpStatus.OK)
  @Roles('owner', 'manager')
  @RequirePermission('canAccessInventory')
  @ApiOperation({
    summary: 'Archivar varios productos en lote',
    description: 'Espejo PlacePos. Idempotente; ids ya archivados se ignoran.',
  })
  @ApiBody({ type: BulkArchiveProductsDto })
  @ApiResponse({ status: HttpStatus.OK, type: BulkArchiveProductsResponseDto })
  @ApiResponse({ status: HttpStatus.BAD_REQUEST, description: 'Payload inválido' })
  async bulkArchive(
    @Body() dto: BulkArchiveProductsDto,
    @CurrentCompany() companyId: number,
  ): Promise<BulkArchiveProductsResponseDto> {
    const result = await this.productsService.bulkArchive(dto.ids, companyId);
    return result;
  }

  /**
   * `PUT /inventory/show-in-pos` — Bulk toggle de visibilidad. Espejo PlacePos.
   * Reemplaza al endpoint single `PUT /:id/show-in-pos`.
   */
  @Put('show-in-pos')
  @HttpCode(HttpStatus.OK)
  @Roles('owner', 'manager')
  @RequirePermission('canAccessInventory')
  @ApiOperation({
    summary: 'Activar/desactivar varios productos en POS en lote',
    description: 'Espejo PlacePos.',
  })
  @ApiBody({ type: BulkToggleShowInPosDto })
  @ApiResponse({ status: HttpStatus.OK, type: BulkToggleShowInPosResponseDto })
  @ApiResponse({ status: HttpStatus.BAD_REQUEST, description: 'Payload inválido' })
  async bulkToggleShowInPos(
    @Body() dto: BulkToggleShowInPosDto,
    @CurrentCompany() companyId: number,
  ): Promise<BulkToggleShowInPosResponseDto> {
    return this.productsService.bulkToggleShowInPos(dto.ids, dto.show_in_pos, companyId);
  }

  @Get(':id')
  @Roles('owner', 'manager', 'employee')
  @ApiOperation({ summary: 'Obtener detalle de un producto' })
  @ApiParam({ name: 'id', type: 'integer', example: 1 })
  @ApiResponse({ status: HttpStatus.OK, type: ProductResponseDto })
  @ApiResponse({ status: HttpStatus.UNAUTHORIZED, description: 'Token ausente o inválido' })
  @ApiResponse({ status: HttpStatus.NOT_FOUND, description: 'Producto no encontrado' })
  async findOne(
    @Param('id', ParseIntPipe) id: number,
    @CurrentCompany() companyId: number,
  ): Promise<ProductResponseDto> {
    const product = await this.productsService.findById(id, companyId);
    if (!product) {
      throw new NotFoundException('Producto no encontrado.');
    }
    // Si es presentación, resolvemos el stock del padre para que el
    // `stock_display` derive correctamente (espejo PlacePos).
    let parentStock: number | null = null;
    if (product.parent_id !== null && product.parent_id !== undefined) {
      const parent = await this.productsService.findById(Number(product.parent_id), companyId);
      parentStock = parent ? Number(parent.stock) : null;
    }
    const [dto] = await this.attachImageUrls(
      [toProductResponseDto(product, parentStock)],
      companyId,
    );
    return dto;
  }

  /**
   * `POST /inventory/:id/image` — Sube o REEMPLAZA la imagen del item.
   *
   * Multipart, campo `image`. Vale igual para producto base, presentación y
   * combo: los tres son filas de `products`. Una imagen por item — subir otra
   * reemplaza la anterior, que se borra del bucket (nunca se acumulan).
   */
  @Post(':id/image')
  @Roles('owner', 'manager')
  @RequirePermission('canAccessInventory')
  @HttpCode(HttpStatus.OK)
  @UseInterceptors(
    FileInterceptor('image', {
      limits: { fileSize: ProductsController.MULTER_IMAGE_CEILING_BYTES, files: 1 },
    }),
  )
  @ApiOperation({
    summary: 'Subir o reemplazar la imagen de un item del inventario',
    description:
      'Multipart form-data con el campo `image`. Formatos JPG/PNG/WebP validados por los bytes ' +
      'reales del archivo, no por el Content-Type. La imagen anterior se elimina del bucket.',
  })
  @ApiConsumes('multipart/form-data')
  @ApiParam({ name: 'id', type: 'integer', example: 1 })
  @ApiBody({
    schema: {
      type: 'object',
      properties: { image: { type: 'string', format: 'binary' } },
      required: ['image'],
    },
  })
  @ApiResponse({ status: HttpStatus.OK, type: ProductImageResponseDto })
  @ApiResponse({
    status: HttpStatus.BAD_REQUEST,
    description: 'Archivo ausente o formato inválido',
  })
  @ApiResponse({ status: HttpStatus.NOT_FOUND, description: 'Producto no encontrado' })
  @ApiResponse({ status: HttpStatus.PAYLOAD_TOO_LARGE, description: 'La imagen supera el límite' })
  @ApiResponse({
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    description: 'El producto está archivado',
  })
  @ApiResponse({
    status: HttpStatus.SERVICE_UNAVAILABLE,
    description: 'Almacenamiento de imágenes no configurado',
  })
  async uploadImage(
    @Param('id', ParseIntPipe) id: number,
    @UploadedFile() file: Express.Multer.File | undefined,
    @CurrentCompany() companyId: number,
    @CurrentUser() currentUser: AuthUser,
  ): Promise<ProductImageResponseDto> {
    return this.productImagesService.upload({
      productId: id,
      companyId,
      file,
      actor: {
        id: currentUser.user_id,
        fullName: `${currentUser.name} ${currentUser.lastname}`.trim(),
      },
    });
  }

  /**
   * `POST /inventory/:id/image/remove` — Quita la imagen del item y la borra
   * del bucket. Idempotente (`removed: false` si no tenía).
   *
   * Es POST y no DELETE por la regla §9.9 del proyecto: el API no expone verbo
   * DELETE.
   */
  @Post(':id/image/remove')
  @Roles('owner', 'manager')
  @RequirePermission('canAccessInventory')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Quitar la imagen de un item del inventario' })
  @ApiParam({ name: 'id', type: 'integer', example: 1 })
  @ApiResponse({ status: HttpStatus.OK, type: RemoveProductImageResponseDto })
  @ApiResponse({ status: HttpStatus.NOT_FOUND, description: 'Producto no encontrado' })
  async removeImage(
    @Param('id', ParseIntPipe) id: number,
    @CurrentCompany() companyId: number,
    @CurrentUser() currentUser: AuthUser,
  ): Promise<RemoveProductImageResponseDto> {
    return this.productImagesService.remove({
      productId: id,
      companyId,
      actor: {
        id: currentUser.user_id,
        fullName: `${currentUser.name} ${currentUser.lastname}`.trim(),
      },
    });
  }

  /**
   * Puebla `image_url` (URL firmada) a partir de la ruta guardada en `image`.
   *
   * Se hace en lote y sobre el resultado ya mapeado. Un producto cuya URL no se
   * pudo firmar viaja con `image_url: null` y el front pinta el placeholder: el
   * listado del inventario no puede caerse porque el bucket esté indispuesto.
   */
  private async attachImageUrls(
    dtos: ProductResponseDto[],
    companyId: number,
  ): Promise<ProductResponseDto[]> {
    const urls = await this.productImagesService.resolveUrls(
      dtos.map((dto) => dto.image),
      companyId,
    );
    if (urls.size === 0) {
      return dtos;
    }
    for (const dto of dtos) {
      dto.image_url = dto.image ? (urls.get(dto.image) ?? null) : null;
    }
    return dtos;
  }

  @Get(':id/sales-history')
  @Roles('owner', 'manager', 'employee')
  @ApiOperation({
    summary: 'Historial de ventas de un producto',
    description:
      'Líneas de venta (SALE, no anuladas) donde aparece el producto, con resumen ' +
      '(veces facturado, unidades, venta/costo/ganancia totales y margen promedio).',
  })
  @ApiParam({ name: 'id', type: 'integer', example: 1 })
  @ApiResponse({ status: HttpStatus.OK, type: SalesHistoryResponseDto })
  @ApiResponse({ status: HttpStatus.UNAUTHORIZED, description: 'Token ausente o inválido' })
  @ApiResponse({ status: HttpStatus.NOT_FOUND, description: 'Producto no encontrado' })
  async salesHistory(
    @Param('id', ParseIntPipe) id: number,
    @CurrentCompany() companyId: number,
  ): Promise<SalesHistoryResponseDto> {
    return this.productsService.getSalesHistory(id, companyId);
  }

  /**
   * `GET /inventory/:productId/supplier-history/:supplierId` — Últimas 10
   * compras del producto al proveedor. Si es una presentación, resuelve al
   * producto padre.
   */
  @Get(':productId/supplier-history/:supplierId')
  @Roles('owner', 'manager', 'employee')
  @ApiOperation({
    summary: 'Últimas 10 compras del producto a un proveedor específico',
    description:
      'Si el producto es una presentación (parent_id != null), se resuelve al producto padre antes de la búsqueda.',
  })
  @ApiParam({ name: 'productId', type: 'integer' })
  @ApiParam({ name: 'supplierId', type: 'integer' })
  @ApiResponse({ status: HttpStatus.OK, type: SupplierHistoryResponseDto })
  @ApiResponse({ status: HttpStatus.NOT_FOUND, description: 'Producto no encontrado' })
  async supplierHistory(
    @Param('productId', ParseIntPipe) productId: number,
    @Param('supplierId', ParseIntPipe) supplierId: number,
    @CurrentCompany() companyId: number,
  ): Promise<SupplierHistoryResponseDto> {
    return this.productsService.findSupplierHistory(productId, supplierId, companyId);
  }

  /**
   * `GET /inventory/:id/price-comparison` — Último precio de compra por
   * proveedor para el producto (DISTINCT ON supplier_id). Resuelve a padre
   * si es presentación.
   */
  @Get(':id/price-comparison')
  @Roles('owner', 'manager', 'employee')
  @ApiOperation({
    summary: 'Último precio de compra por proveedor para el producto',
    description:
      'DISTINCT ON supplier_id ordenado por fecha desc. Si es presentación, resuelve al producto padre.',
  })
  @ApiParam({ name: 'id', type: 'integer' })
  @ApiResponse({ status: HttpStatus.OK, type: PriceComparisonResponseDto })
  @ApiResponse({ status: HttpStatus.NOT_FOUND, description: 'Producto no encontrado' })
  async priceComparison(
    @Param('id', ParseIntPipe) id: number,
    @CurrentCompany() companyId: number,
  ): Promise<PriceComparisonResponseDto> {
    return this.productsService.comparePrices(id, companyId);
  }

  @Post()
  @Roles('owner', 'manager')
  @RequirePermission('canAccessInventory')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Crear producto' })
  @ApiBody({ type: CreateProductDto })
  @ApiResponse({ status: HttpStatus.CREATED, type: ProductMinimalResponseDto })
  @ApiResponse({ status: HttpStatus.BAD_REQUEST, description: 'Payload inválido' })
  @ApiResponse({ status: HttpStatus.UNAUTHORIZED, description: 'Token ausente o inválido' })
  @ApiResponse({ status: HttpStatus.FORBIDDEN, description: 'Rol insuficiente' })
  @ApiResponse({ status: HttpStatus.NOT_FOUND, description: 'parent_id / packaging_id inválido' })
  async create(
    @Body() dto: CreateProductDto,
    @CurrentCompany() companyId: number,
    @CurrentUser() currentUser: AuthUser,
  ): Promise<ProductMinimalResponseDto> {
    const product = await this.productsService.create(dto, companyId, {
      id: currentUser.user_id,
      fullName: `${currentUser.name} ${currentUser.lastname}`.trim(),
    });
    return {
      id: Number(product.id),
      name: product.name,
      created_by: product.created_by ?? null,
      created_at: product.created_at.toISOString(),
    };
  }

  /**
   * `POST /inventory/:id/duplicate` — Duplica un producto del catálogo.
   *
   * Copia todo salvo SKU, código de barras (únicos) y stock (arranca en 0).
   * El nombre lleva el sufijo "COPIA" (numerado si ya existía). Espejo PlacePos.
   */
  @Post(':id/duplicate')
  @Roles('owner', 'manager')
  @RequirePermission('canAccessInventory')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Duplicar un producto',
    description:
      'Crea una copia con el mismo costo, precios, categoría, empaque, descripción y receta ' +
      '(si es COMBO). NO copia sku_code ni bar_code (son únicos) y el stock arranca en 0. ' +
      'El nombre es "<NOMBRE> COPIA", numerado si ya existe.',
  })
  @ApiParam({ name: 'id', type: 'integer', example: 1 })
  @ApiResponse({ status: HttpStatus.CREATED, type: DuplicateProductResponseDto })
  @ApiResponse({ status: HttpStatus.BAD_REQUEST, description: 'Receta del combo inválida' })
  @ApiResponse({ status: HttpStatus.UNAUTHORIZED, description: 'Token ausente o inválido' })
  @ApiResponse({ status: HttpStatus.FORBIDDEN, description: 'Rol insuficiente' })
  @ApiResponse({ status: HttpStatus.NOT_FOUND, description: 'Producto no encontrado' })
  async duplicate(
    @Param('id', ParseIntPipe) id: number,
    @CurrentCompany() companyId: number,
    @CurrentUser() currentUser: AuthUser,
  ): Promise<DuplicateProductResponseDto> {
    const product = await this.productsService.duplicate(id, companyId, {
      id: currentUser.user_id,
      fullName: `${currentUser.name} ${currentUser.lastname}`.trim(),
    });
    return {
      id: Number(product.id),
      name: product.name,
      source_id: id,
      created_by: product.created_by ?? null,
      created_at: product.created_at.toISOString(),
    };
  }

  @Put(':id')
  @Roles('owner', 'manager')
  @RequirePermission('canAccessInventory')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Actualizar producto + precios' })
  @ApiParam({ name: 'id', type: 'integer', example: 1 })
  @ApiBody({ type: UpdateProductDto })
  @ApiResponse({ status: HttpStatus.OK, type: ProductMinimalResponseDto })
  @ApiResponse({
    status: HttpStatus.BAD_REQUEST,
    description: 'Payload inválido o UNIQUE colision',
  })
  @ApiResponse({ status: HttpStatus.UNAUTHORIZED, description: 'Token ausente o inválido' })
  @ApiResponse({ status: HttpStatus.FORBIDDEN, description: 'Rol insuficiente' })
  @ApiResponse({ status: HttpStatus.NOT_FOUND, description: 'Producto no encontrado' })
  async update(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateProductDto,
    @CurrentCompany() companyId: number,
    @CurrentUser() currentUser: AuthUser,
  ): Promise<ProductMinimalResponseDto> {
    const product = await this.productsService.update(id, dto, companyId, {
      id: currentUser.user_id,
      fullName: `${currentUser.name} ${currentUser.lastname}`.trim(),
    });
    return {
      id: Number(product.id),
      name: product.name,
      updated_by: product.updated_by ?? null,
      updated_at: product.updated_at.toISOString(),
    };
  }
}
