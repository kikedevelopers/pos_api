/**
 * Política de reintento ante 40001 (serialization_failure) para editar y
 * anular ventas, que corren en SERIALIZABLE. Backoff lineal corto con jitter
 * (≈30·n ms) para desincronizar transacciones que chocaron entre sí.
 */
export const SALE_SERIALIZABLE_RETRY = { maxRetries: 6, backoffMs: 30, jitter: true } as const;
