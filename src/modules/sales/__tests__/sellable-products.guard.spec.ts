import { BadRequestException } from '@nestjs/common';

import { ProductType } from '@/modules/products/entities/product.entity';

import {
  assertSellableProducts,
  type SellableProductRef,
} from '../internal/sellable-products.guard';

function ref(over: Partial<SellableProductRef> = {}): SellableProductRef {
  return {
    name: 'MANI CON SAL',
    product_type: ProductType.SIMPLE,
    is_archived: false,
    ...over,
  };
}

/**
 * Este guard es lo único que se interpone entre el POS y el INSERT de la venta.
 * Cubre las dos razones de rechazo y, sobre todo, fija que un COMBO SÍ es
 * vendible: antes de la receta el guard exigía `SIMPLE` y el POS cloud abortaba
 * el cobro de un combo con "no es un producto simple disponible".
 */
describe('assertSellableProducts', () => {
  describe('acepta', () => {
    it('un producto simple', () => {
      expect(() => assertSellableProducts([ref()])).not.toThrow();
    });

    it('un COMBO (se explota en su receta al descontar inventario)', () => {
      expect(() =>
        assertSellableProducts([ref({ name: 'UVA PASA Y MANI', product_type: ProductType.COMBO })]),
      ).not.toThrow();
    });

    it('una PRESENTACIÓN (SIMPLE; el parent_id no es asunto del guard)', () => {
      expect(() => assertSellableProducts([ref({ name: 'MANI X LIBRA' })])).not.toThrow();
    });

    it('una mezcla de simples y combos en la misma venta', () => {
      expect(() =>
        assertSellableProducts([
          ref(),
          ref({ name: 'UVA PASA Y MANI', product_type: ProductType.COMBO }),
          ref({ name: 'FLOR DE JAMAICA' }),
        ]),
      ).not.toThrow();
    });

    it('una lista vacía (sin líneas no hay nada que validar)', () => {
      expect(() => assertSellableProducts([])).not.toThrow();
    });
  });

  describe('rechaza', () => {
    it('un producto archivado, nombrándolo', () => {
      expect(() => assertSellableProducts([ref({ is_archived: true })])).toThrow(
        new BadRequestException('El producto "MANI CON SAL" está archivado'),
      );
    });

    it('un COMBO archivado', () => {
      expect(() =>
        assertSellableProducts([
          ref({ name: 'UVA PASA Y MANI', product_type: ProductType.COMBO, is_archived: true }),
        ]),
      ).toThrow(new BadRequestException('El producto "UVA PASA Y MANI" está archivado'));
    });

    it('nombra al PRIMER ofensor cuando hay varios archivados', () => {
      expect(() =>
        assertSellableProducts([
          ref(),
          ref({ name: 'PRIMERO', is_archived: true }),
          ref({ name: 'SEGUNDO', is_archived: true }),
        ]),
      ).toThrow(new BadRequestException('El producto "PRIMERO" está archivado'));
    });

    it('un tipo desconocido (defensa ante un enum futuro no vendible)', () => {
      expect(() =>
        assertSellableProducts([ref({ name: 'SERVICIO', product_type: 'SERVICE' as ProductType })]),
      ).toThrow(
        new BadRequestException('El producto "SERVICIO" no es un producto disponible para venta'),
      );
    });

    it('reporta el TIPO antes que el archivado cuando concurren', () => {
      expect(() =>
        assertSellableProducts([
          ref({ name: 'ARCHIVADO', is_archived: true }),
          ref({ name: 'RARO', product_type: 'SERVICE' as ProductType }),
        ]),
      ).toThrow(
        new BadRequestException('El producto "RARO" no es un producto disponible para venta'),
      );
    });

    it('lanza BadRequestException (400, no 500) para que el POS muestre el motivo', () => {
      expect.assertions(2);
      try {
        assertSellableProducts([ref({ is_archived: true })]);
      } catch (error) {
        expect(error).toBeInstanceOf(BadRequestException);
        expect((error as BadRequestException).getStatus()).toBe(400);
      }
    });
  });
});
