import { accessibleProductsPredicate } from '../accessible-products.helper';

/**
 * El predicado tiene dos modos y confundirlos tiene consecuencias opuestas:
 *
 *   - Activar la REGLA 5 en un listado masivo lo vuelve ~29× más lento (medido
 *     sobre BD real: 0,9 ms → 26,5 ms) y además muestra en la sucursal
 *     componentes que no debe poder vender sueltos.
 *   - Desactivarla al resolver ids concretos rompe la venta de un combo
 *     compartido: el motor no alcanza el componente para descontarlo.
 *
 * Estos tests fijan el contrato de ambos modos, incluida la correspondencia
 * entre placeholders y `params` — un desajuste ahí produce un error de SQL o,
 * peor, un filtro de company equivocado.
 */
describe('accessibleProductsPredicate', () => {
  const countPlaceholders = (sql: string): number => new Set(sql.match(/\$\d+/g) ?? []).size;

  describe('por defecto (listados masivos)', () => {
    it('NO incluye la regla de componentes de combo', () => {
      const { sql } = accessibleProductsPredicate('p', 42, 1);
      expect(sql).not.toContain('combo_components');
    });

    it('conserva las cuatro reglas de compartición', () => {
      const { sql } = accessibleProductsPredicate('p', 42, 1);
      // Propio + share total + share por producto + presentación de un padre compartido.
      expect(sql).toContain('p.company_id = $1');
      expect(sql).toContain('inventory_shares');
      expect(sql).toContain('p.parent_id IS NOT NULL');
    });

    it('emite exactamente 5 parámetros, uno por placeholder', () => {
      const { sql, params } = accessibleProductsPredicate('p', 42, 1);
      expect(params).toHaveLength(5);
      expect(countPlaceholders(sql)).toBe(5);
      expect(new Set(params)).toEqual(new Set(['42']));
    });

    it('no deja placeholders huérfanos de la regla omitida', () => {
      const { sql } = accessibleProductsPredicate('p', 42, 1);
      expect(sql).not.toContain('$6');
      expect(sql).not.toContain('$7');
    });
  });

  describe('con includeComboComponents (ids concretos)', () => {
    it('incluye la regla de componentes de combo', () => {
      const { sql } = accessibleProductsPredicate('p', 42, 1, {
        includeComboComponents: true,
      });
      expect(sql).toContain('combo_components');
    });

    it('emite exactamente 7 parámetros, uno por placeholder', () => {
      const { sql, params } = accessibleProductsPredicate('p', 42, 1, {
        includeComboComponents: true,
      });
      expect(params).toHaveLength(7);
      expect(countPlaceholders(sql)).toBe(7);
    });

    it('acota el componente a la company del combo (sin fuga cross-tenant)', () => {
      const { sql } = accessibleProductsPredicate('p', 42, 1, {
        includeComboComponents: true,
      });
      expect(sql).toContain('cc.component_product_id = p.id');
      expect(sql).toContain('cc.company_id = p.company_id');
    });
  });

  describe('numeración de placeholders', () => {
    it('respeta el índice inicial que pide el caller', () => {
      const { sql } = accessibleProductsPredicate('p', 42, 2);
      // `resolveAccessibleProducts` reserva $1 para el array de ids.
      expect(sql).toContain('p.company_id = $2');
      expect(sql).not.toContain('$1');
    });

    it('numera de forma contigua desde el índice inicial', () => {
      const { sql } = accessibleProductsPredicate('p', 42, 3, {
        includeComboComponents: true,
      });
      const used = [...new Set(sql.match(/\$\d+/g) ?? [])]
        .map((ph) => Number(ph.slice(1)))
        .sort((a, b) => a - b);
      expect(used).toEqual([3, 4, 5, 6, 7, 8, 9]);
    });
  });

  it('usa el alias que recibe', () => {
    const { sql } = accessibleProductsPredicate('prod', 42, 1);
    expect(sql).toContain('prod.company_id');
    expect(sql).not.toContain('p.company_id');
  });
});
