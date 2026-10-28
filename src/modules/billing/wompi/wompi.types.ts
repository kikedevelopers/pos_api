/**
 * Formas de los objetos de Wompi que usa este módulo. Solo lo que se lee: si
 * Wompi añade campos, no rompen nada.
 */
export type WompiTransactionStatus = 'PENDING' | 'APPROVED' | 'DECLINED' | 'VOIDED' | 'ERROR';
/** Se tipa `string`: Wompi puede sumar estados y lo desconocido se trata como pendiente. */

export interface WompiTransaction {
  id: string;
  status: string;
  status_message?: string | null;
  amount_in_cents: number;
  currency: string;
  reference?: string | null;
  payment_link_id?: string | null;
  payment_method_type?: string | null;
  customer_email?: string | null;
  created_at?: string;
  finalized_at?: string | null;
}

export interface WompiPaymentLink {
  id: string;
  active?: boolean;
  amount_in_cents?: number | null;
  currency?: string;
  expires_at?: string | null;
}

export interface CreatePaymentLinkInput {
  name: string;
  description: string;
  amount_in_cents: number;
  currency: string;
  redirect_url: string;
  expires_at: Date;
  /** Referencia propia (≤ 36 caracteres): cruza el pago con el panel de Wompi. */
  sku: string;
}

/** Evento que Wompi manda al webhook. */
export interface WompiEvent {
  event: string;
  data: Record<string, unknown> & { transaction?: Partial<WompiTransaction> };
  environment?: string;
  signature?: { properties?: unknown; checksum?: unknown };
  timestamp?: unknown;
  sent_at?: string;
}
