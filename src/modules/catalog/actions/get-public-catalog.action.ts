import { Injectable, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { preciseNumber } from '@/common/utils/precision';
import { Company } from '@/modules/companies/entities/company.entity';
import { ProductImagesService } from '@/modules/product-images/product-images.service';

import { normalizeSlug } from '../internal/catalog-slug';
import type { PublicCatalogResponseDto } from '../dto/public-catalog-response.dto';

/** Fila cruda del SQL del catálogo. `pg` devuelve numeric/bigint como string. */
interface RawCatalogRow {
  id: string;
  name: string;
  description: string | null;
  category_name: string | null;
  image_path: string | null;
  out_of_stock: boolean;
  prices: Array<{ name: string | null; sale_price: string | number }> | null;
}

/**
 * Sirve el catálogo PÚBLICO de un negocio por su slug.
 *
 * Seguridad / privacidad:
 *   - Resuelve la company por `catalog_slug` y SOLO si `catalog_enabled = true`.
 *     Si el slug no existe o el catálogo está apagado → 404 (anti-enumeración:
 *     un cliente no distingue "no existe" de "existe pero sin publicar").
 *   - Expone únicamente datos públicos: nombre, descripción, categoría, imagen y
 *     PRECIOS DE VENTA. Jamás costo, ganancia, margen ni stock.
 *   - Multi-tenant estricto: todos los productos se filtran por la company
 *     resuelta. Solo los no archivados y con `show_in_pos = true`.
 *
 * Read puro, sin autenticación (endpoint `@Public()`).
 */
@Injectable()
export class GetPublicCatalogAction {
  constructor(
    private readonly dataSource: DataSource,
    private readonly productImages: ProductImagesService,
  ) {}

  async execute(rawSlug: string): Promise<PublicCatalogResponseDto> {
    const slug = normalizeSlug(rawSlug ?? '');
    if (slug.length === 0) {
      throw new NotFoundException('Catálogo no encontrado');
    }

    const company = await this.dataSource.manager.findOne(Company, {
      where: { catalog_slug: slug, catalog_enabled: true },
      select: {
        id: true,
        name: true,
        catalog_slug: true,
        catalog_group_by_category: true,
        catalog_cover_image: true,
      },
    });
    if (!company) {
      // No distinguimos "no existe" de "existe pero no publicado".
      throw new NotFoundException('Catálogo no encontrado');
    }

    const companyId = Number(company.id);

    const rows = await this.dataSource.query<RawCatalogRow[]>(
      `
      SELECT
        p.id            AS id,
        p.name          AS name,
        p.description   AS description,
        cat.name        AS category_name,
        -- Imagen EFECTIVA: la presentación vinculada toma la del base.
        CASE
          WHEN p.use_parent_image = true AND p.parent_id IS NOT NULL THEN parent.image
          ELSE p.image
        END             AS image_path,
        p.catalog_out_of_stock AS out_of_stock,
        COALESCE(pr.prices, '[]'::jsonb) AS prices
      FROM products p
      LEFT JOIN categories cat ON cat.id = p.category_id
      LEFT JOIN products parent
             ON parent.id = p.parent_id AND parent.company_id = p.company_id
      LEFT JOIN LATERAL (
        SELECT jsonb_agg(
          jsonb_build_object('name', pp.name, 'sale_price', pp.sale_price)
          ORDER BY pp.sale_price
        ) AS prices
        FROM product_prices pp
        WHERE pp.product_id = p.id
      ) pr ON TRUE
      WHERE p.company_id = $1
        AND p.is_archived = false
        AND p.show_in_pos = true
        AND p.catalog_visible = true
        -- Una categoría oculta excluye a TODOS sus productos; sin categoría = visible.
        AND (cat.id IS NULL OR cat.catalog_visible = true)
      ORDER BY p.name ASC
      `,
      [companyId],
    );

    // Firmar en lote las URLs de las imágenes (proxy HMAC, endpoint público).
    // Incluye la portada del catálogo para firmarla en el mismo lote.
    const imageUrls = await this.productImages.resolveUrls(
      [...rows.map((row) => row.image_path), company.catalog_cover_image],
      companyId,
    );
    const coverImageUrl = company.catalog_cover_image
      ? (imageUrls.get(company.catalog_cover_image) ?? null)
      : null;

    const products = rows.map((row) => ({
      id: Number(row.id),
      name: row.name,
      description: row.description,
      category: row.category_name,
      image_url: row.image_path ? (imageUrls.get(row.image_path) ?? null) : null,
      out_of_stock: row.out_of_stock === true,
      prices: (row.prices ?? []).map((price) => ({
        name: price.name ?? 'Precio',
        price: preciseNumber(price.sale_price ?? 0, 2),
      })),
    }));

    return {
      business: {
        name: company.name,
        slug: company.catalog_slug ?? slug,
        group_by_category: company.catalog_group_by_category ?? false,
        cover_image_url: coverImageUrl,
      },
      products,
      count: products.length,
    };
  }
}
