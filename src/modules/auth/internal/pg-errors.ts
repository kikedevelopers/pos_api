/**
 * Postgres SQLSTATE para `unique_violation`. Se detecta en el catch del
 * register para traducir la race condition email-tomado a 409 con `code`.
 */
export const PG_UNIQUE_VIOLATION = '23505';
