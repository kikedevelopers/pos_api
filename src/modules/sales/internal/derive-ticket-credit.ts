import { SaleCreditStatus } from '../entities/sale-credit.entity';

/**
 * Vocabulario de estado de crédito del CLIENTE (PlacePos). El cloud usa
 * `PARTIALLY_PAID`; el cliente usa `PARTIAL`. Normalizamos aquí para paridad.
 */
export type TicketCreditStatus = 'PENDING' | 'PARTIAL' | 'PAID';

export interface TicketCreditInfo {
  isCredit: boolean;
  creditStatus: TicketCreditStatus | null;
}

export function mapSaleCreditStatus(status: SaleCreditStatus): TicketCreditStatus {
  switch (status) {
    case SaleCreditStatus.PARTIALLY_PAID:
      return 'PARTIAL';
    case SaleCreditStatus.PAID:
      return 'PAID';
    default:
      return 'PENDING';
  }
}

/**
 * Deriva la señal de "venta a crédito" para el feed de tickets del POS a partir
 * de la relación `credit` de la venta. Espejo de `placepos/ticketCredit.ts`.
 * Una venta es a crédito si tiene registro de crédito (aunque ya esté pagado).
 */
export function deriveTicketCredit(
  credit: { status: SaleCreditStatus } | null | undefined,
): TicketCreditInfo {
  if (!credit) {
    return { isCredit: false, creditStatus: null };
  }
  return { isCredit: true, creditStatus: mapSaleCreditStatus(credit.status) };
}
