import { computeComboCost, computeComboStock, computeComponentCost } from '../combo-costing';

/**
 * Espejo del suite de placepos (`comboCosting.test.ts`). Ambos repos DEBEN dar
 * el mismo número para el mismo escenario: si divergen, el costo del combo
 * cambia al migrar de offline a cloud.
 *
 * Escenario canónico:
 *   MANÍ CON SAL X KILO → cost 12.000 / empaque KILO (1000) ⇒ $12/g
 *   UVA PASA X KILO     → cost 20.000 / empaque KILO (1000) ⇒ $20/g
 *   COMBO MIX = 25 g de maní + 30 g de uva pasa ⇒ 300 + 600 = 900
 */

const MANI = { component_cost: 12000, component_packaging_value: 1000 };
const UVA = { component_cost: 20000, component_packaging_value: 1000 };

describe('computeComponentCost — aporte de un componente', () => {
  it('convierte el costo del empaque a unidad mínima y lo multiplica por la cantidad', () => {
    expect(computeComponentCost({ ...MANI, quantity: 25 })).toBe(300);
    expect(computeComponentCost({ ...UVA, quantity: 30 })).toBe(600);
  });

  it('sin empaque (null) el costo ya está en unidad mínima ⇒ factor 1', () => {
    expect(
      computeComponentCost({
        component_cost: 2500,
        component_packaging_value: null,
        quantity: 3,
      }),
    ).toBe(7500);
  });

  it('empaque inválido (0 o negativo) degrada a factor 1 en vez de dividir por cero', () => {
    expect(
      computeComponentCost({ component_cost: 1000, component_packaging_value: 0, quantity: 2 }),
    ).toBe(2000);
    expect(
      computeComponentCost({ component_cost: 1000, component_packaging_value: -5, quantity: 2 }),
    ).toBe(2000);
  });

  it('redondea a 2 decimales (numeric(15,2))', () => {
    expect(
      computeComponentCost({ component_cost: 1000, component_packaging_value: 3, quantity: 1 }),
    ).toBe(333.33);
  });

  it('cantidad no positiva o no finita ⇒ 0 (nunca NaN a la BD)', () => {
    expect(computeComponentCost({ ...MANI, quantity: 0 })).toBe(0);
    expect(computeComponentCost({ ...MANI, quantity: -10 })).toBe(0);
    expect(computeComponentCost({ ...MANI, quantity: Number.NaN })).toBe(0);
  });
});

describe('computeComboCost — costo total de la receta', () => {
  it('escenario mix maní + uva pasa: 300 + 600 = 900', () => {
    expect(
      computeComboCost([
        { ...MANI, quantity: 25 },
        { ...UVA, quantity: 30 },
      ]),
    ).toBe(900);
  });

  it('escenario combo hamburguesa (3 bases unitarios sin empaque)', () => {
    expect(
      computeComboCost([
        { component_cost: 4500, component_packaging_value: 1, quantity: 1 },
        { component_cost: 1800, component_packaging_value: 1, quantity: 1 },
        { component_cost: 1200, component_packaging_value: 1, quantity: 1 },
      ]),
    ).toBe(7500);
  });

  it('el total es EXACTAMENTE la suma de los aportes mostrados por componente', () => {
    const components = [
      { component_cost: 1000, component_packaging_value: 3, quantity: 1 },
      { component_cost: 1000, component_packaging_value: 3, quantity: 1 },
    ];
    expect(components.map(computeComponentCost)).toEqual([333.33, 333.33]);
    expect(computeComboCost(components)).toBe(666.66);
  });

  it('lista vacía ⇒ 0', () => {
    expect(computeComboCost([])).toBe(0);
  });
});

describe('computeComboStock — cuántos combos se pueden armar', () => {
  it('toma el MÍNIMO entre los componentes', () => {
    expect(
      computeComboStock([
        { component_stock: 1000, quantity: 25 },
        { component_stock: 600, quantity: 30 },
      ]),
    ).toBe(20);
  });

  it('trunca: no se venden combos incompletos', () => {
    expect(computeComboStock([{ component_stock: 249, quantity: 25 }])).toBe(9);
  });

  it('un componente agotado deja el combo en 0 aunque los demás sobren', () => {
    expect(
      computeComboStock([
        { component_stock: 100000, quantity: 25 },
        { component_stock: 0, quantity: 30 },
      ]),
    ).toBe(0);
  });

  it('sin componentes ⇒ 0', () => {
    expect(computeComboStock([])).toBe(0);
  });

  it('sobregiro leve ⇒ 0, no −1', () => {
    expect(Object.is(computeComboStock([{ component_stock: -2, quantity: 25 }]), 0)).toBe(true);
  });

  it('sobregiro grande queda en negativo', () => {
    expect(computeComboStock([{ component_stock: -300, quantity: 25 }])).toBe(-12);
  });
});
