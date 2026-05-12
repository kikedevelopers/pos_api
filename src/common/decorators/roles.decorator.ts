import { SetMetadata } from '@nestjs/common';

import type { UserType } from '@/common/types/jwt-payload.type';

/**
 * Clave de metadata leída por `RolesGuard`.
 */
export const ROLES_KEY = 'roles';

/**
 * Restringe el endpoint a un conjunto de `UserType`s.
 *
 * Ejemplo:
 *   @Roles('owner')                       // solo owners
 *   @Roles('owner', 'manager')            // ambos
 *
 * Sin decorador, el endpoint queda abierto a cualquier usuario autenticado
 * (asumiendo que pase por `JwtAuthGuard`).
 */
export const Roles = (...types: UserType[]): MethodDecorator & ClassDecorator =>
  SetMetadata(ROLES_KEY, types);
