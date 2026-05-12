/**
 * Claims que firmamos en el JWT y que esperamos al verificar.
 *
 * Importante:
 *   - `user_id` y `company_id` se guardan como `number`. PG los entrega como
 *     `string` (bigint), pero la conversión a `number` se hace en el service
 *     que firma el token. El JwtStrategy NO los re-castea — confía en el
 *     payload del token.
 *   - `company_id` es `null` SOLO para `type === 'superadmin'`. Cualquier
 *     otro `null` es un bug y debe rechazarse al validar.
 *   - `account` discrimina entre `User` y `Employee` (Fase 2). Por ahora
 *     siempre será `'user'`.
 *
 * El shape coincide byte-a-byte con el JWT que emite PlacePos local (ver
 * `placepos/src/main/server/routes/auth.routes.ts`), salvo por el claim
 * adicional `company_id` que el modo CLOUD requiere para multi-tenancy.
 */
export type UserType = 'superadmin' | 'owner' | 'manager' | 'employee';
export type AccountKind = 'user' | 'employee';

export interface JwtPayload {
  user_id: number;
  company_id: number | null;
  name: string;
  lastname: string;
  type: UserType;
  account: AccountKind;
  /** Issued at — añadido por `jsonwebtoken` automáticamente. */
  iat?: number;
  /** Expiration — añadido por `jsonwebtoken` según `expiresIn`. */
  exp?: number;
}

/**
 * Forma del objeto que el `JwtStrategy.validate` cuelga en `request.user`.
 * Es estructuralmente idéntico al payload, sin los claims temporales
 * (`iat`/`exp`) que solo le interesan al verificador del token, no al
 * controller.
 */
export interface AuthUser {
  user_id: number;
  company_id: number | null;
  name: string;
  lastname: string;
  type: UserType;
  account: AccountKind;
}
