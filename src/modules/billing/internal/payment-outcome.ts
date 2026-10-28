import { addDays } from '@/modules/subscriptions/subscriptions.constants';

import { SubscriptionPaymentStatus } from '../entities/subscription-payment.entity';
import type { WompiTransaction } from '../wompi/wompi.types';

/**
 * Qué hacer con una transacción de Wompi frente a un pago nuestro.
 *
 * Función PURA: es la regla que decide si se cargan días por dinero real, así
 * que vive aislada y con tests de cada rama. Ninguna rama aprueba "por si
 * acaso": solo `APPROVED` + mismo link + mismo monto + misma moneda carga días.
 */
export interface PaymentSnapshot {
  payment_link_id: string;
  amount_in_cents: string | number;
  currency: string;
}

export type TransactionOutcome =
  /** Pagó lo que debía: cargar días. */
  | { kind: 'approve' }
  /** Terminó sin cobro (rechazada, anulada, error). */
  | {
      kind: 'reject';
      status:
        | SubscriptionPaymentStatus.DECLINED
        | SubscriptionPaymentStatus.VOIDED
        | SubscriptionPaymentStatus.ERROR;
    }
  /** Sigue en proceso (PSE/Nequi pendientes): esperar. */
  | { kind: 'pending' }
  /** Wompi la aprobó pero no cuadra con lo cobrado: revisión manual + alerta. */
  | { kind: 'needs_review'; reason: string }
  /** La transacción es de otro link: no se toca este pago. */
  | { kind: 'foreign'; reason: string };

export function evaluateTransaction(
  payment: PaymentSnapshot,
  transaction: Pick<
    WompiTransaction,
    'status' | 'amount_in_cents' | 'currency' | 'payment_link_id'
  >,
): TransactionOutcome {
  if (!transaction.payment_link_id || transaction.payment_link_id !== payment.payment_link_id) {
    return {
      kind: 'foreign',
      reason: `La transacción pertenece al link ${transaction.payment_link_id ?? '(ninguno)'}, no a ${payment.payment_link_id}.`,
    };
  }

  switch (transaction.status) {
    case 'APPROVED': {
      const expected = Number(payment.amount_in_cents);
      if (!Number.isSafeInteger(expected) || transaction.amount_in_cents !== expected) {
        return {
          kind: 'needs_review',
          reason: `Monto aprobado ${transaction.amount_in_cents} ≠ monto cobrado ${payment.amount_in_cents} (centavos).`,
        };
      }
      if (transaction.currency !== payment.currency) {
        return {
          kind: 'needs_review',
          reason: `Moneda aprobada ${transaction.currency} ≠ ${payment.currency}.`,
        };
      }
      return { kind: 'approve' };
    }
    case 'DECLINED':
      return { kind: 'reject', status: SubscriptionPaymentStatus.DECLINED };
    case 'VOIDED':
      return { kind: 'reject', status: SubscriptionPaymentStatus.VOIDED };
    case 'ERROR':
      return { kind: 'reject', status: SubscriptionPaymentStatus.ERROR };
    default:
      // PENDING o un estado nuevo que no conocemos: nunca se aprueba ni se
      // rechaza a ciegas. Se espera al siguiente evento o al barrido.
      return { kind: 'pending' };
  }
}

/**
 * Nuevo período al cargar `days` días.
 *
 * Los días se SUMAN a lo que le quede: quien paga con 5 días de prueba por
 * delante no los pierde. Si ya venció, el período arranca hoy (no se le cobran
 * los días en que estuvo bloqueado).
 */
export function computeExtension(
  current_expires_at: Date,
  days: number,
  now: Date,
): { period_starts_at: Date; period_ends_at: Date; was_expired: boolean } {
  if (!Number.isInteger(days) || days <= 0) {
    throw new Error(`Días a cargar inválidos: ${days}`);
  }
  const was_expired = current_expires_at.getTime() <= now.getTime();
  const period_starts_at = was_expired ? now : current_expires_at;
  return { period_starts_at, period_ends_at: addDays(period_starts_at, days), was_expired };
}

/** Texto para el dueño cuando el pago no pasó. */
export function describeRejection(
  status: SubscriptionPaymentStatus,
  provider_message?: string | null,
): string {
  const base =
    status === SubscriptionPaymentStatus.DECLINED
      ? 'Tu banco o medio de pago rechazó la transacción.'
      : status === SubscriptionPaymentStatus.VOIDED
        ? 'La transacción fue anulada.'
        : 'El medio de pago reportó un error al procesar la transacción.';
  const detail = provider_message?.trim();
  return detail ? `${base} Detalle: ${detail}` : base;
}
