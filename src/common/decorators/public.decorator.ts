import { SetMetadata } from '@nestjs/common';

/**
 * Clave de metadata leída por `JwtAuthGuard` para saltarse la verificación
 * del JWT. Exportada para que el guard la reutilice (evita strings mágicas).
 */
export const IS_PUBLIC_KEY = 'isPublic';

/**
 * Marca un endpoint como público (sin auth).
 *
 * Uso típico:
 *   - `POST /auth/register`
 *   - `POST /auth/user`
 *   - `POST /auth/logout`
 *   - `GET  /health`
 *
 * El guard global `JwtAuthGuard` lee esta metadata vía `Reflector` y, si la
 * encuentra, deja pasar la request sin exigir token. **No** afecta a
 * `RolesGuard` (que solo actúa cuando el endpoint tiene `@Roles(...)`).
 */
export const Public = (): MethodDecorator & ClassDecorator => SetMetadata(IS_PUBLIC_KEY, true);
