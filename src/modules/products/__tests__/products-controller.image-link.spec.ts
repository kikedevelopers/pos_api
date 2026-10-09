import { ProductsController } from '../products.controller';
import { ProductType } from '../entities/product.entity';
import type { Product } from '../entities/product.entity';

/**
 * Integración del `GET /inventory` (findAll) para el VÍNCULO de imagen
 * presentación→base: una presentación con `use_parent_image = true` debe recibir
 * su `image_url` firmada desde la imagen del PADRE (no tiene propia). El base y
 * las presentaciones con imagen propia conservan la suya.
 *
 * Prueba el cableado real del controller (construcción de `parentImageById` +
 * `attachImageUrls` + `effectiveImagePath`), con un `ProductImagesService` doble
 * que firma las rutas que recibe.
 */

const BASE_IMAGE = 'inventory_items/1/5-base.jpg';
const OWN_IMAGE = 'inventory_items/1/7-own.jpg';

function buildProduct(over: Partial<Product>): Product {
  return {
    id: '1',
    company_id: '1',
    name: 'Producto',
    bar_code: null,
    sku_code: null,
    description: null,
    cost: '100',
    stock: '0',
    product_type: ProductType.SIMPLE,
    parent_id: null,
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
    ...over,
  } as unknown as Product;
}

describe('ProductsController.findAll · vínculo de imagen presentación→base', () => {
  function buildController(products: Product[]) {
    const productsService = {
      findAll: jest.fn().mockResolvedValue(products),
    };
    // Doble del firmador: "firma" cada ruta recibida como signed://<ruta>.
    const productImagesService = {
      resolveUrls: jest.fn((paths: Array<string | null>) => {
        const map = new Map<string, string>();
        for (const p of paths) {
          if (p) map.set(p, `signed://${p}`);
        }
        return Promise.resolve(map);
      }),
    };
    const controller = new ProductsController(
      productsService as never,
      productImagesService as never,
    );
    return { controller, productImagesService };
  }

  it('la presentación vinculada recibe la URL firmada del padre', async () => {
    const base = buildProduct({ id: '5', name: 'CAFE *KL', parent_id: null, image: BASE_IMAGE });
    const linked = buildProduct({
      id: '6',
      name: 'CAFE *250G',
      parent_id: '5',
      use_parent_image: true,
      image: null,
    });
    const own = buildProduct({
      id: '7',
      name: 'CAFE *500G',
      parent_id: '5',
      use_parent_image: false,
      image: OWN_IMAGE,
    });

    const { controller } = buildController([base, linked, own]);
    const dtos = await controller.findAll({}, 1);
    const byId = new Map(dtos.map((d) => [d.id, d]));

    expect(byId.get(5)?.image_url).toBe(`signed://${BASE_IMAGE}`);
    // La vinculada: URL del PADRE aunque su propia `image` sea null.
    expect(byId.get(6)?.image_url).toBe(`signed://${BASE_IMAGE}`);
    expect(byId.get(6)?.image).toBeNull();
    expect(byId.get(6)?.use_parent_image).toBe(true);
    // La de imagen propia: la suya.
    expect(byId.get(7)?.image_url).toBe(`signed://${OWN_IMAGE}`);
  });

  it('presentación vinculada a un base SIN imagen → image_url null', async () => {
    const base = buildProduct({ id: '5', name: 'TE *KL', parent_id: null, image: null });
    const linked = buildProduct({
      id: '6',
      name: 'TE *100G',
      parent_id: '5',
      use_parent_image: true,
      image: null,
    });

    const { controller } = buildController([base, linked]);
    const dtos = await controller.findAll({}, 1);
    const byId = new Map(dtos.map((d) => [d.id, d]));

    expect(byId.get(6)?.image_url).toBeNull();
  });
});
