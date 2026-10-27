import type { EntityManager } from 'typeorm';

/**
 * Unidad de trabajo compartida entre préstamos y sus integraciones.
 *
 * Hoy préstamos vive en la misma base que el POS: registrar un préstamo y
 * sacar el dinero de Tesorería ocurren en UNA transacción (nada queda a
 * medias). Los puertos reciben esta transacción para participar en ella.
 *
 * Al separar préstamos en su propia API, esta atomicidad pasa a ser un flujo
 * entre servicios (p. ej. outbox + compensación): solo cambian los adaptadores
 * de `integration/`, no las actions.
 */
export type LendingTx = EntityManager;
