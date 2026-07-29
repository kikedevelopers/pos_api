import { BadRequestException } from '@nestjs/common';
import { QueryFailedError } from 'typeorm';

import type { ProductPriceInputDto } from '../dto/product-price.dto';
import {
  PG_FOREIGN_KEY_VIOLATION,
  PG_UNIQUE_VIOLATION,
  translateProductPriceDeleteError,
} from '../internal/constraint-errors';
import { pairIncomingPrices, syncProductPrices } from '../internal/sync-product-prices';

/**
 * Regresión del 500 al editar el precio de un producto que entró por compra.
 *
 * PlacePos ≤ 1.0.0 reconstruye el array `prices` del formulario SIN el `id`.
 * Con la semántica "el array es fuente de verdad" eso significaba borrar todos
 * los precios e insertarlos de nuevo, y el DELETE viola las FKs
 * `product_price_history.product_price_id` / `sale_invoice_lines.product_price_id`
 * (ambas NO ACTION) en cuanto el producto se compró o se vendió.
 */
describe('pairIncomingPrices', () => {
  const price = (input: Partial<ProductPriceInputDto>): ProductPriceInputDto => ({
    sale_price: 0,
    ...input,
  });

  describe('modo legacy (ningún precio entrante trae id)', () => {
    it('empareja por posición → UPDATE in-place, sin DELETE', () => {
      const { pairs, toDelete } = pairIncomingPrices(
        [price({ sale_price: 4000 })],
        [{ id: '51580' }],
      );

      expect(pairs).toEqual([{ input: { sale_price: 4000 }, targetId: '51580' }]);
      expect(toDelete).toEqual([]);
    });

    it('ordena los existentes por id ascendente (orden de creación)', () => {
      const { pairs } = pairIncomingPrices(
        [price({ sale_price: 100 }), price({ sale_price: 200 })],
        // Llegan desordenados desde la relación de TypeORM.
        [{ id: '90' }, { id: '12' }],
      );

      expect(pairs.map((p) => p.targetId)).toEqual(['12', '90']);
    });

    it('compara los ids numéricamente, no como strings ("9" < "10")', () => {
      const { pairs } = pairIncomingPrices(
        [price({ sale_price: 1 }), price({ sale_price: 2 })],
        [{ id: '10' }, { id: '9' }],
      );

      expect(pairs.map((p) => p.targetId)).toEqual(['9', '10']);
    });

    it('inserta los precios entrantes que exceden a los existentes', () => {
      const { pairs, toDelete } = pairIncomingPrices(
        [price({ sale_price: 100 }), price({ sale_price: 200 })],
        [{ id: '7' }],
      );

      expect(pairs.map((p) => p.targetId)).toEqual(['7', null]);
      expect(toDelete).toEqual([]);
    });

    it('borra los existentes sobrantes cuando el cliente quita un nivel', () => {
      const { pairs, toDelete } = pairIncomingPrices(
        [price({ sale_price: 100 })],
        [{ id: '7' }, { id: '8' }],
      );

      expect(pairs.map((p) => p.targetId)).toEqual(['7']);
      expect(toDelete).toEqual(['8']);
    });

    it('inserta todo cuando el producto no tiene precios previos', () => {
      const { pairs, toDelete } = pairIncomingPrices([price({ sale_price: 100 })], []);

      expect(pairs.map((p) => p.targetId)).toEqual([null]);
      expect(toDelete).toEqual([]);
    });

    it('acepta id numérico en los existentes (no solo string)', () => {
      const { pairs } = pairIncomingPrices([price({ sale_price: 100 })], [{ id: 42 }]);

      expect(pairs.map((p) => p.targetId)).toEqual(['42']);
    });
  });

  describe('modo por id (cliente moderno)', () => {
    it('actualiza el precio cuyo id llega y borra el que no', () => {
      const { pairs, toDelete } = pairIncomingPrices(
        [price({ id: 8, sale_price: 4000 })],
        [{ id: '7' }, { id: '8' }],
      );

      expect(pairs.map((p) => p.targetId)).toEqual(['8']);
      expect(toDelete).toEqual(['7']);
    });

    it('mantiene el emparejamiento por id aunque el orden difiera', () => {
      const { pairs, toDelete } = pairIncomingPrices(
        [price({ id: 8, sale_price: 200 }), price({ id: 7, sale_price: 100 })],
        [{ id: '7' }, { id: '8' }],
      );

      expect(pairs.map((p) => p.targetId)).toEqual(['8', '7']);
      expect(toDelete).toEqual([]);
    });

    it('array mixto: el que trae id actualiza, el que no lo trae se INSERTA', () => {
      // Con un solo id presente NO se activa el modo posicional: el precio sin
      // id es un nivel nuevo agregado en el formulario.
      const { pairs, toDelete } = pairIncomingPrices(
        [price({ id: 7, sale_price: 100 }), price({ sale_price: 200 })],
        [{ id: '7' }],
      );

      expect(pairs.map((p) => p.targetId)).toEqual(['7', null]);
      expect(toDelete).toEqual([]);
    });

    it('un id que NO pertenece al producto se trata como INSERT, no como UPDATE', () => {
      // Defensa anti cross-tenant: el UPDATE filtrado por product_id no
      // afectaría filas, y el precio se perdería silenciosamente.
      const { pairs, toDelete } = pairIncomingPrices(
        [price({ id: 999, sale_price: 100 })],
        [{ id: '7' }],
      );

      expect(pairs.map((p) => p.targetId)).toEqual([null]);
      expect(toDelete).toEqual(['7']);
    });
  });
});

describe('syncProductPrices', () => {
  interface ManagerMock {
    delete: jest.Mock;
    update: jest.Mock;
    insert: jest.Mock;
  }

  const buildManager = (overrides: Partial<ManagerMock> = {}): ManagerMock => ({
    delete: jest.fn(() => Promise.resolve({ affected: 1, raw: [] })),
    update: jest.fn(() => Promise.resolve({ affected: 1, raw: [], generatedMaps: [] })),
    insert: jest.fn(() => Promise.resolve({ identifiers: [], generatedMaps: [], raw: [] })),
    ...overrides,
  });

  /** Argumento `index` de la llamada `call` del mock, tipado como objeto plano. */
  const argOf = (mock: jest.Mock, call: number, index: number): Record<string, unknown> =>
    (mock.mock.calls[call] as unknown[])[index] as Record<string, unknown>;

  const actor = { id: 7, fullName: 'Kike' };

  const run = (
    manager: ManagerMock,
    incoming: ProductPriceInputDto[],
    existing: { id: string }[],
  ): Promise<void> =>
    syncProductPrices({
      manager: manager as never,
      companyId: 42,
      productId: '7366',
      cost: 3550,
      incoming,
      existing,
      actor,
    });

  it('cliente legacy sobre producto con historial: UPDATE, nunca DELETE', async () => {
    const manager = buildManager();

    await run(manager, [{ sale_price: 4000 }], [{ id: '51580' }]);

    expect(manager.delete).not.toHaveBeenCalled();
    expect(manager.insert).not.toHaveBeenCalled();
    expect(manager.update).toHaveBeenCalledTimes(1);
    expect(argOf(manager.update, 0, 1)).toEqual({
      id: '51580',
      product_id: '7366',
      company_id: '42',
    });
  });

  it('recalcula profit/margin con Big.js e ignora los hints del cliente', async () => {
    const manager = buildManager();

    await run(manager, [{ sale_price: 4000, profit: 99999, margin: 99999 }], [{ id: '51580' }]);

    // 4000 - 3550 = 450 ; 450 / 4000 * 100 = 11.25
    expect(argOf(manager.update, 0, 2)).toMatchObject({
      sale_price: 4000,
      profit: 450,
      margin: 11.25,
    });
  });

  it('profit negativo cuando el precio queda por debajo del costo', async () => {
    const manager = buildManager();

    await run(manager, [{ sale_price: 3500 }], [{ id: '51580' }]);

    expect(argOf(manager.update, 0, 2)).toMatchObject({ profit: -50 });
  });

  it('margin = 0 cuando sale_price = 0 (evita división por cero)', async () => {
    const manager = buildManager();

    await run(manager, [{ sale_price: 0 }], [{ id: '51580' }]);

    expect(argOf(manager.update, 0, 2)).toMatchObject({ margin: 0 });
  });

  it('el INSERT lleva company_id/product_id del contexto y el actor', async () => {
    const manager = buildManager();

    await run(manager, [{ sale_price: 4000 }], []);

    expect(argOf(manager.insert, 0, 1)).toMatchObject({
      company_id: '42',
      product_id: '7366',
      sale_price: 4000,
      created_by: 'Kike',
      created_by_id: '7',
    });
  });

  it('el DELETE filtra por product_id + company_id (anti cross-tenant)', async () => {
    const manager = buildManager();

    await run(manager, [{ id: 7, sale_price: 100 }], [{ id: '7' }, { id: '8' }]);

    expect(manager.delete).toHaveBeenCalledTimes(1);
    expect(argOf(manager.delete, 0, 1)).toMatchObject({
      product_id: '7366',
      company_id: '42',
    });
  });

  it('traduce la violación de FK del DELETE a 400 legible (no 500)', async () => {
    const fkError = new QueryFailedError('DELETE', [], new Error('fk')) as QueryFailedError & {
      code: string;
    };
    fkError.code = PG_FOREIGN_KEY_VIOLATION;

    const manager = buildManager({
      delete: jest.fn(() => Promise.reject(fkError)),
    });

    await expect(
      run(manager, [{ id: 7, sale_price: 100 }], [{ id: '7' }, { id: '8' }]),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('un error de DELETE que NO es FK se relanza tal cual', async () => {
    const boom = new Error('conexión perdida');
    const manager = buildManager({ delete: jest.fn(() => Promise.reject(boom)) });

    await expect(
      run(manager, [{ id: 7, sale_price: 100 }], [{ id: '7' }, { id: '8' }]),
    ).rejects.toBe(boom);
  });
});

describe('translateProductPriceDeleteError', () => {
  it('no lanza si el error no es de TypeORM', () => {
    expect(() => translateProductPriceDeleteError(new Error('x'))).not.toThrow();
  });

  it('no lanza si el SQLSTATE no es 23503', () => {
    const error = new QueryFailedError('DELETE', [], new Error('x')) as QueryFailedError & {
      code: string;
    };
    error.code = PG_UNIQUE_VIOLATION;

    expect(() => translateProductPriceDeleteError(error)).not.toThrow();
  });

  it('lanza 400 con code PRODUCT_PRICE_IN_USE ante 23503', () => {
    const error = new QueryFailedError('DELETE', [], new Error('x')) as QueryFailedError & {
      code: string;
    };
    error.code = PG_FOREIGN_KEY_VIOLATION;

    try {
      translateProductPriceDeleteError(error);
      throw new Error('debió lanzar');
    } catch (thrown) {
      expect(thrown).toBeInstanceOf(BadRequestException);
      expect((thrown as BadRequestException).getResponse()).toMatchObject({
        payload: { code: 'PRODUCT_PRICE_IN_USE' },
      });
    }
  });
});
