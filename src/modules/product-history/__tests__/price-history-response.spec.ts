import { ProductCostHistoryEvent } from '../entities/product-cost-history.entity';
import type { ProductPriceHistory } from '../entities/product-price-history.entity';
import { toPriceHistoryEntryDto } from '../dto/price-history-response.dto';

/**
 * Un snapshot cuyo nivel de precio se eliminó conserva TODO el dato monetario y
 * solo pierde el puntero (`product_price_id = NULL`, FK SET NULL). El mapper no
 * debe convertir ese NULL en 0 — sería un id falso apuntando a nada.
 */
describe('toPriceHistoryEntryDto', () => {
  const baseEntry = (
    overrides: Partial<ProductPriceHistory> = {},
  ): ProductPriceHistory =>
    ({
      id: '10',
      company_id: '42',
      product_price_id: '7',
      product_id: '99',
      cost_history_id: '5',
      sale_price: 25000,
      profit_before: 1000,
      profit_after: 1500,
      margin_before: 10,
      margin_after: 15,
      created_by: 'Kike',
      created_by_id: '1',
      created_at: new Date('2026-08-05T12:00:00.000Z'),
      ...overrides,
    }) as ProductPriceHistory;

  const joined = { purchase_id: 17, event_type: ProductCostHistoryEvent.RECEIVE };

  it('mapea el id del nivel cuando existe', () => {
    expect(toPriceHistoryEntryDto(baseEntry(), joined).product_price_id).toBe(7);
  });

  it('deja product_price_id en null si el nivel fue eliminado', () => {
    const dto = toPriceHistoryEntryDto(baseEntry({ product_price_id: null }), joined);

    expect(dto.product_price_id).toBeNull();
  });

  it('el snapshot monetario sobrevive intacto al borrado del nivel', () => {
    const dto = toPriceHistoryEntryDto(baseEntry({ product_price_id: null }), joined);

    expect(dto).toMatchObject({
      product_id: 99,
      sale_price: 25000,
      profit_before: 1000,
      profit_after: 1500,
      margin_before: 10,
      margin_after: 15,
      purchase_id: 17,
      event_type: ProductCostHistoryEvent.RECEIVE,
    });
  });

  it('cost_history_id nulo sigue mapeando a null (no a 0)', () => {
    const dto = toPriceHistoryEntryDto(
      baseEntry({ product_price_id: null, cost_history_id: null }),
      { purchase_id: null, event_type: null },
    );

    expect(dto.cost_history_id).toBeNull();
    expect(dto.purchase_id).toBeNull();
  });
});
