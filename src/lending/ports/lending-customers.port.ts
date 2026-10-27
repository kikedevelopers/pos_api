import type { LendingTx } from './lending-tx';

/** Token de inyección del puerto de clientes. */
export const LENDING_CUSTOMERS = Symbol('LENDING_CUSTOMERS');

/** Lo único que préstamos necesita saber de un cliente. */
export interface LendingCustomer {
  id: number;
  name: string;
}

/**
 * Clientes vistos desde préstamos. Los clientes son del negocio (hoy viven en
 * el POS); préstamos solo los lee, nunca los modifica.
 */
export interface LendingCustomersPort {
  /** Cliente ACTIVO (no archivado) de la company, o null. */
  findActive(companyId: number, customerId: number, tx?: LendingTx): Promise<LendingCustomer | null>;
  /** Nombres por id (para listar préstamos). Ids desconocidos no aparecen. */
  namesByIds(companyId: number, customerIds: number[]): Promise<Map<number, string>>;
}
