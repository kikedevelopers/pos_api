import {
  RANK_STEP,
  rankAtEnd,
  rankBetween,
  rebalancedPositions,
} from '../kanban-ranking';

describe('kanban-ranking · rankAtEnd', () => {
  it('lista vacía → primer paso', () => {
    expect(rankAtEnd(null)).toBe(RANK_STEP);
  });
  it('añade un paso después del máximo', () => {
    expect(rankAtEnd(2048)).toBe(2048 + RANK_STEP);
  });
});

describe('kanban-ranking · rankBetween', () => {
  it('sin vecinos (lista vacía) → primer paso', () => {
    expect(rankBetween(null, null)).toBe(RANK_STEP);
  });
  it('al inicio (sin prev) → un paso por debajo del primero', () => {
    expect(rankBetween(null, 1024)).toBe(1024 - RANK_STEP);
  });
  it('al final (sin next) → un paso por encima del último', () => {
    expect(rankBetween(2048, null)).toBe(2048 + RANK_STEP);
  });
  it('entre dos vecinos → punto medio', () => {
    expect(rankBetween(1000, 2000)).toBe(1500);
  });
  it('hueco suficiente → no pide rebalanceo', () => {
    expect(rankBetween(1000, 1000.01)).not.toBeNull();
  });
  it('hueco agotado → null (rebalanceo necesario)', () => {
    expect(rankBetween(1000, 1000 + 1e-9)).toBeNull();
    expect(rankBetween(5, 5)).toBeNull();
  });
});

describe('kanban-ranking · rebalancedPositions', () => {
  it('genera posiciones equiespaciadas por STEP', () => {
    expect(rebalancedPositions(3)).toEqual([RANK_STEP, 2 * RANK_STEP, 3 * RANK_STEP]);
  });
  it('count 0 → arreglo vacío', () => {
    expect(rebalancedPositions(0)).toEqual([]);
  });
});
