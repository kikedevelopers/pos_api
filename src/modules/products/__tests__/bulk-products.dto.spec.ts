import { plainToInstance } from 'class-transformer';
import { validate, type ValidationError } from 'class-validator';

import { BulkProductsDto } from '../dto/bulk-products.dto';

/**
 * Tests unitarios (CI-safe, SIN BD) de la validación del DTO de importación
 * masiva `POST /inventory/bulk`. Reproducen exactamente lo que hace el
 * `ValidationPipe` global del backend: `plainToInstance` + `validate` con
 * `{ whitelist: true, forbidNonWhitelisted: true }`.
 *
 * Cubre:
 *   - item válido completo (incluye `description`) → 0 errores (blinda el fix
 *     del bug original donde `description` no estaba en el DTO).
 *   - propiedad desconocida `foo` → error "should not exist" (whitelist).
 *   - `name` vacío → error (`IsNotEmpty`).
 *   - `cost` negativo → error (`Min(0)`).
 *   - `stock` con > 4 decimales → error (`maxDecimalPlaces: 4`).
 *   - `prices` con 5 niveles → `ArrayMaxSize` (tope 4).
 *   - `sale_price` negativo → error (`Min(0)`).
 */

const VALIDATE_OPTS = { whitelist: true, forbidNonWhitelisted: true } as const;

/** Aplana todos los `constraints` de un árbol de ValidationError a strings. */
function flattenConstraints(errors: ValidationError[]): string[] {
  const out: string[] = [];
  const walk = (errs: ValidationError[]): void => {
    for (const e of errs) {
      if (e.constraints) {
        out.push(...Object.values(e.constraints));
      }
      if (e.children && e.children.length > 0) {
        walk(e.children);
      }
    }
  };
  walk(errors);
  return out;
}

/** Junta las KEYS de constraint (p.ej. `isNotEmpty`, `whitelistValidation`). */
function flattenConstraintKeys(errors: ValidationError[]): string[] {
  const out: string[] = [];
  const walk = (errs: ValidationError[]): void => {
    for (const e of errs) {
      if (e.constraints) {
        out.push(...Object.keys(e.constraints));
      }
      if (e.children && e.children.length > 0) {
        walk(e.children);
      }
    }
  };
  walk(errors);
  return out;
}

async function validatePayload(payload: unknown): Promise<ValidationError[]> {
  const instance = plainToInstance(BulkProductsDto, payload);
  return validate(instance, VALIDATE_OPTS);
}

describe('BulkProductsDto / BulkItemDto validation', () => {
  it('item válido completo (con description) → 0 errores', async () => {
    const errors = await validatePayload({
      items: [
        {
          name: 'Coca-Cola 2L',
          sku_code: 'SKU-12345',
          bar_code: '7591001234567',
          category: 'Bebidas',
          description: 'Botella retornable de 2 litros',
          stock: 10,
          cost: 2.5,
          show_in_pos: true,
          is_purchasable: false,
          prices: [{ sale_price: 5.0 }],
        },
      ],
    });
    expect(errors).toHaveLength(0);
  });

  it('propiedad desconocida `foo` → error whitelist "should not exist"', async () => {
    const errors = await validatePayload({
      items: [
        {
          name: 'Producto X',
          sku_code: 'SKU-X',
          cost: 1.0,
          prices: [{ sale_price: 5.0 }],
          foo: 'x',
        },
      ],
    });
    expect(errors.length).toBeGreaterThan(0);
    const messages = flattenConstraints(errors);
    expect(messages.some((m) => m.includes('should not exist'))).toBe(true);
    expect(flattenConstraintKeys(errors)).toContain('whitelistValidation');
  });

  it('`name` vacío → error IsNotEmpty', async () => {
    const errors = await validatePayload({
      items: [{ name: '', cost: 1.0, prices: [{ sale_price: 5.0 }] }],
    });
    expect(errors.length).toBeGreaterThan(0);
    expect(flattenConstraintKeys(errors)).toContain('isNotEmpty');
  });

  it('`cost` negativo → error Min(0)', async () => {
    const errors = await validatePayload({
      items: [{ name: 'Producto X', cost: -5, prices: [{ sale_price: 5.0 }] }],
    });
    expect(errors.length).toBeGreaterThan(0);
    const messages = flattenConstraints(errors);
    expect(messages.some((m) => m.includes('cost'))).toBe(true);
    expect(flattenConstraintKeys(errors)).toContain('min');
  });

  it('`stock` con > 4 decimales → error maxDecimalPlaces', async () => {
    const errors = await validatePayload({
      items: [{ name: 'Producto X', stock: 1.23456, cost: 1.0, prices: [{ sale_price: 5.0 }] }],
    });
    expect(errors.length).toBeGreaterThan(0);
    const messages = flattenConstraints(errors);
    expect(messages.some((m) => m.includes('stock'))).toBe(true);
    expect(flattenConstraintKeys(errors)).toContain('isNumber');
  });

  it('`prices` con 5 niveles → ArrayMaxSize (tope 4)', async () => {
    const errors = await validatePayload({
      items: [
        {
          name: 'Producto X',
          cost: 1.0,
          prices: [
            { sale_price: 1 },
            { sale_price: 2 },
            { sale_price: 3 },
            { sale_price: 4 },
            { sale_price: 5 },
          ],
        },
      ],
    });
    expect(errors.length).toBeGreaterThan(0);
    const messages = flattenConstraints(errors);
    expect(messages.some((m) => m.includes('prices'))).toBe(true);
    expect(flattenConstraintKeys(errors)).toContain('arrayMaxSize');
  });

  it('`sale_price` negativo → error Min(0)', async () => {
    const errors = await validatePayload({
      items: [{ name: 'Producto X', cost: 1.0, prices: [{ sale_price: -3 }] }],
    });
    expect(errors.length).toBeGreaterThan(0);
    const messages = flattenConstraints(errors);
    expect(messages.some((m) => m.includes('sale_price'))).toBe(true);
    expect(flattenConstraintKeys(errors)).toContain('min');
  });

  it('items vacío → error ArrayMinSize', async () => {
    const errors = await validatePayload({ items: [] });
    expect(errors.length).toBeGreaterThan(0);
    expect(flattenConstraintKeys(errors)).toContain('arrayMinSize');
  });
});
