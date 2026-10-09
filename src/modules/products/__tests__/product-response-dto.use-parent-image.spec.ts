import { toProductResponseDto } from '../dto/product-response.dto';
import { ProductType } from '../entities/product.entity';
import type { Product } from '../entities/product.entity';

/**
 * El mapper expone `use_parent_image` para que el formulario sepa si la
 * presentación está vinculada a la imagen del base. `image_url` se firma aparte
 * (en el controller), aquí solo se verifica el passthrough del flag.
 */
function buildProduct(overrides: Partial<Product>): Product {
  return {
    id: '42',
    company_id: '1',
    name: 'Presentación *G',
    bar_code: null,
    sku_code: null,
    description: null,
    cost: '100',
    stock: '0',
    product_type: ProductType.SIMPLE,
    parent_id: '5',
    packaging_id: null,
    category_id: null,
    tax_rate_id: null,
    image: null,
    use_parent_image: false,
    show_in_pos: true,
    is_purchasable: false,
    is_archived: false,
    created_by: null,
    updated_by: null,
    created_at: new Date('2026-10-09T12:00:00.000Z'),
    updated_at: new Date('2026-10-09T12:00:00.000Z'),
    packaging: null,
    category: null,
    prices: [],
    cloned_from_company_id: null,
    ...overrides,
  } as unknown as Product;
}

describe('toProductResponseDto · use_parent_image', () => {
  it('mapea use_parent_image = true', () => {
    const dto = toProductResponseDto(buildProduct({ use_parent_image: true }), 0);
    expect(dto.use_parent_image).toBe(true);
    // Vinculada: no tiene imagen propia; la URL la firma el controller.
    expect(dto.image).toBeNull();
    expect(dto.image_url).toBeNull();
  });

  it('mapea use_parent_image = false', () => {
    const dto = toProductResponseDto(buildProduct({ use_parent_image: false }), 0);
    expect(dto.use_parent_image).toBe(false);
  });

  it('un valor ausente (dump antiguo) se normaliza a false', () => {
    const dto = toProductResponseDto(
      buildProduct({ use_parent_image: undefined as unknown as boolean }),
      0,
    );
    expect(dto.use_parent_image).toBe(false);
  });
});
