import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';

import type { QuickCreateProductDto } from '../dto/quick-create-product.dto';
import { Product, ProductType } from '../entities/product.entity';
import { ProductPrice } from '../entities/product-price.entity';
import { translateProductConstraintError } from '../internal/constraint-errors';
import { assertPackagingBelongsToCompany } from '../internal/product-lookups';

/**
 * Actor que crea el producto. Snapshot para `created_by` / `created_by_id`.
 */
export interface QuickProductCreator {
  id: number;
  fullName: string;
}

/**
 * `POST /inventory/quick` — Crea un producto mínimo desde el módulo de
 * compras (espejo PlacePos línea 705-785).
 *
 * Reglas:
 *   - `name` trimeado; rechazo si quedaría vacío (cubre el caso "    ").
 *   - `packaging_id` opcional; si viene, debe pertenecer a la company
 *     (anti cross-tenant).
 *   - `cost > 0`. La validación de número está en el DTO.
 *   - Producto creado con:
 *       `product_type   = SIMPLE`
 *       `show_in_pos    = false`   // PlacePos lo hace así
 *       `is_purchasable = true`    // espejo PlacePos línea 751
 *       `is_archived    = false`
 *       `stock          = 0`       // quick-create siempre arranca en 0
 *   - Inserta UN ProductPrice con `sale_price = cost`, profit = 0, margin = 0.
 *   - Colisiones UNIQUE → 400 con código (translate constraint).
 *
 * Transacción: INSERT product + INSERT price deben ser atómicos.
 */
@Injectable()
export class QuickCreateProductAction {
  private readonly logger = new Logger(QuickCreateProductAction.name);

  constructor(private readonly dataSource: DataSource) {}

  async execute(
    dto: QuickCreateProductDto,
    companyId: number,
    createdBy: QuickProductCreator,
  ): Promise<Product> {
    const trimmedName = dto.name.trim();
    // El DTO ya valida @IsNotEmpty, pero defendemos contra strings espacio-only.
    if (trimmedName.length === 0) {
      throw new BadRequestException('El nombre es requerido.');
    }

    return this.dataSource.transaction<Product>(async (manager) => {
      await assertPackagingBelongsToCompany(manager, dto.packaging_id ?? null, companyId);

      const product = manager.create(Product, {
        company_id: String(companyId),
        name: trimmedName,
        description: null,
        product_type: ProductType.SIMPLE,
        parent_id: null,
        sku_code: null,
        bar_code: null,
        packaging_id: dto.packaging_id ? String(dto.packaging_id) : null,
        category_id: null,
        cost: dto.cost,
        stock: 0,
        image: null,
        show_in_pos: false,
        is_purchasable: true,
        is_archived: false,
        hash: null,
        created_by: createdBy.fullName,
        created_by_id: String(createdBy.id),
      });

      let saved: Product;
      try {
        saved = await manager.save(Product, product);
      } catch (error) {
        translateProductConstraintError(error);
        throw error;
      }

      const price = manager.create(ProductPrice, {
        company_id: String(companyId),
        product_id: saved.id,
        name: '',
        sale_price: dto.cost,
        profit: 0,
        margin: 0,
        iva_percentage: 0,
        created_by: createdBy.fullName,
        created_by_id: String(createdBy.id),
      });
      await manager.save(ProductPrice, price);

      this.logger.log({
        event: 'product.quick_created',
        companyId,
        productId: Number(saved.id),
        cost: dto.cost,
      });

      // Re-fetch con relations para devolver el producto completo.
      return manager.findOneOrFail(Product, {
        where: { id: saved.id, company_id: String(companyId) },
        relations: { prices: true, packaging: true, category: true },
      });
    });
  }
}
