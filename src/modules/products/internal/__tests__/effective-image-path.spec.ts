import { effectiveImagePath } from '../effective-image-path';

/**
 * `effectiveImagePath`: de qué ruta de imagen se firma la URL de un producto.
 *
 * Regla: una presentación VINCULADA (`use_parent_image`) toma la imagen del
 * padre; cualquier otro producto, la suya. El vínculo es lógico y se resuelve
 * aquí (en lectura), nunca se comparte la ruta del objeto en el bucket.
 */
describe('effectiveImagePath', () => {
  const parentImageById = new Map<number, string | null>([
    [5, 'inventory_items/1/5-base.jpg'],
    [9, null], // base sin imagen
  ]);

  it('presentación vinculada → usa la imagen del padre', () => {
    const path = effectiveImagePath(
      { parent_id: 5, use_parent_image: true, image: null },
      parentImageById,
    );
    expect(path).toBe('inventory_items/1/5-base.jpg');
  });

  it('presentación vinculada cuyo padre NO tiene imagen → null (placeholder)', () => {
    const path = effectiveImagePath(
      { parent_id: 9, use_parent_image: true, image: null },
      parentImageById,
    );
    expect(path).toBeNull();
  });

  it('presentación vinculada cuyo padre no está en el mapa → null, no rompe', () => {
    const path = effectiveImagePath(
      { parent_id: 123, use_parent_image: true, image: null },
      parentImageById,
    );
    expect(path).toBeNull();
  });

  it('presentación con imagen propia (sin vínculo) → usa la suya', () => {
    const path = effectiveImagePath(
      { parent_id: 5, use_parent_image: false, image: 'inventory_items/1/42-own.jpg' },
      parentImageById,
    );
    expect(path).toBe('inventory_items/1/42-own.jpg');
  });

  it('producto base → usa su propia imagen (nunca la de nadie)', () => {
    const path = effectiveImagePath(
      { parent_id: null, use_parent_image: false, image: 'inventory_items/1/5-base.jpg' },
      parentImageById,
    );
    expect(path).toBe('inventory_items/1/5-base.jpg');
  });

  it('vinculada pero SIN mapa de padres → cae a su propia imagen (defensivo)', () => {
    const path = effectiveImagePath({ parent_id: 5, use_parent_image: true, image: null });
    expect(path).toBeNull();
  });

  it('use_parent_image ausente/undefined se trata como no vinculada', () => {
    const path = effectiveImagePath(
      { parent_id: 5, image: 'inventory_items/1/42-own.jpg' },
      parentImageById,
    );
    expect(path).toBe('inventory_items/1/42-own.jpg');
  });
});
