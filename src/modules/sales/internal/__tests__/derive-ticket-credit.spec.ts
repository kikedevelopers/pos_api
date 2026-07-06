import { SaleCreditStatus } from '../../entities/sale-credit.entity';
import { deriveTicketCredit, mapSaleCreditStatus } from '../derive-ticket-credit';

describe('deriveTicketCredit (feed del POS · paridad PlacePos)', () => {
  it('sin crédito (null) → no es crédito', () => {
    expect(deriveTicketCredit(null)).toEqual({ isCredit: false, creditStatus: null });
  });

  it('sin crédito (undefined) → no es crédito', () => {
    expect(deriveTicketCredit(undefined)).toEqual({ isCredit: false, creditStatus: null });
  });

  it('crédito PENDING → es crédito con estado PENDING', () => {
    expect(deriveTicketCredit({ status: SaleCreditStatus.PENDING })).toEqual({
      isCredit: true,
      creditStatus: 'PENDING',
    });
  });

  it('crédito PARTIALLY_PAID → normaliza a PARTIAL (vocabulario PlacePos)', () => {
    expect(deriveTicketCredit({ status: SaleCreditStatus.PARTIALLY_PAID })).toEqual({
      isCredit: true,
      creditStatus: 'PARTIAL',
    });
  });

  it('crédito PAID sigue siendo crédito (mantiene el chip)', () => {
    expect(deriveTicketCredit({ status: SaleCreditStatus.PAID })).toEqual({
      isCredit: true,
      creditStatus: 'PAID',
    });
  });

  it('mapSaleCreditStatus mapea los 3 estados', () => {
    expect(mapSaleCreditStatus(SaleCreditStatus.PENDING)).toBe('PENDING');
    expect(mapSaleCreditStatus(SaleCreditStatus.PARTIALLY_PAID)).toBe('PARTIAL');
    expect(mapSaleCreditStatus(SaleCreditStatus.PAID)).toBe('PAID');
  });
});
