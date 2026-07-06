import {
  computeStockDisplay,
  computeChildStockDisplay,
  toMinimalStock,
} from './compute-stock-display';

// El stock se persiste en unidad mínima; stock_display = stock / packaging.value.
// toMinimalStock es el inverso (paquetes → unidad mínima) que usa la importación
// masiva (UPDATE). Espejo EXACTO de PlacePos.
describe('computeStockDisplay (unidad mínima -> display en paquetes)', () => {
  it('divide el stock por el packaging_value', () => {
    expect(computeStockDisplay(120, 12)).toBe(10);
    expect(computeStockDisplay(30000, 10000)).toBe(3);
  });

  it('sin packaging (null/<=0) devuelve el stock crudo', () => {
    expect(computeStockDisplay(42, null)).toBe(42);
    expect(computeStockDisplay(42, 0)).toBe(42);
  });

  it('redondea a 4 decimales (bug original 10/12)', () => {
    expect(computeStockDisplay(10, 12)).toBe(0.8333);
  });
});

describe('toMinimalStock (paquetes -> unidad mínima)', () => {
  it('multiplica los paquetes por el packaging_value', () => {
    expect(toMinimalStock(10, 12)).toBe(120);
    expect(toMinimalStock(3, 10000)).toBe(30000);
  });

  it('sin packaging (null/<=0) devuelve el valor crudo', () => {
    expect(toMinimalStock(42, null)).toBe(42);
    expect(toMinimalStock(42, 0)).toBe(42);
  });

  it('es el inverso exacto de computeStockDisplay (round-trip)', () => {
    for (const [paquetes, value] of [
      [10, 12],
      [3, 10000],
      [60, 500],
      [42, 1],
    ] as Array<[number, number]>) {
      expect(computeStockDisplay(toMinimalStock(paquetes, value), value)).toBe(paquetes);
    }
  });
});

describe('computeChildStockDisplay (presentación desde el padre)', () => {
  it('deriva parentStock / childPackagingValue', () => {
    expect(computeChildStockDisplay(120, 0, 1)).toBe(120);
    expect(computeChildStockDisplay(30000, 0, 500)).toBe(60);
  });

  it('sin padre o sin packaging usa el stock crudo del hijo', () => {
    expect(computeChildStockDisplay(null, 7, 500)).toBe(7);
    expect(computeChildStockDisplay(100, 7, 0)).toBe(7);
  });
});
