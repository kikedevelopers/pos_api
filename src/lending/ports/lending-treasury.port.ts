import type { LendingTx } from './lending-tx';

/** Token de inyección del puerto de tesorería. */
export const LENDING_TREASURY = Symbol('LENDING_TREASURY');

export const DISBURSEMENT_SOURCE_TYPES = ['cash_register', 'bank', 'wallet'] as const;
export type DisbursementSourceType = (typeof DISBURSEMENT_SOURCE_TYPES)[number];

export interface DisbursementActor {
  id: number;
  fullName: string;
}

export interface DisbursementInput {
  companyId: number;
  sourceType: DisbursementSourceType;
  /** Requerido para banco/billetera; la caja es la del actor. */
  sourceId?: number;
  /** Monto a sacar, ya redondeado a 2 decimales. */
  amount: number;
  /** Concepto legible del egreso ("Préstamo a ALONSO REYES"). */
  description: string;
  /** Código único del préstamo: une el egreso con el préstamo. */
  referenceCode: string;
  actor: DisbursementActor;
}

export interface DisbursementResult {
  /** Nombre de la cuenta (snapshot en el préstamo). */
  sourceName: string;
  /** Id real de la cuenta (la caja del actor si fue caja). */
  resolvedSourceId: number;
}

/**
 * Tesorería vista desde préstamos: sacar el dinero prestado de una cuenta.
 *
 * Contrato: el adaptador valida que la cuenta exista en la company y que el
 * saldo alcance (404 / 422 con mensaje para el usuario) y registra el egreso
 * como DESEMBOLSO DE PRÉSTAMO (nunca como gasto), dentro de `tx`.
 */
export interface LendingTreasuryPort {
  disburse(tx: LendingTx, input: DisbursementInput): Promise<DisbursementResult>;
}
