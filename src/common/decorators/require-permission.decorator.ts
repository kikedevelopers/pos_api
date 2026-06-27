import { SetMetadata } from '@nestjs/common';

import type { PermissionKey } from '@/modules/roles/internal/permission-catalog';

/**
 * Clave de metadata leída por `PermissionsGuard`.
 */
export const REQUIRE_PERMISSION_KEY = 'require_permission';

/**
 * Exige que el actor posea un permiso del catálogo (`PermissionKey`) para
 * acceder al endpoint/controller decorado (FASE 4 — enforcement de permisos).
 *
 * Comportamiento (ver `PermissionsGuard`):
 *   - `owner` / `superadmin` SIEMPRE pasan (no dependen del rol).
 *   - empleado: pasa solo si el permiso requerido está en sus permisos
 *     efectivos (resueltos por `ResolveEffectivePermissionsAction`). Si no →
 *     `403 ForbiddenException`.
 *
 * Sin este decorador, el endpoint no hace ninguna consulta de permisos (la
 * inmensa mayoría de rutas). El overhead de resolución solo ocurre cuando la
 * ruta está explícitamente protegida.
 *
 * Se compone CON `@Roles(...)`: `RolesGuard` decide el `UserType` permitido
 * (gating grueso) y `PermissionsGuard` el permiso granular del rol. Para que
 * el permiso sea el gate efectivo de un empleado, `@Roles` debe admitir su
 * tipo; en endpoints `@Roles('owner')`/`('owner','manager')` el permiso es
 * supletorio (el owner pasa siempre, el empleado ya queda fuera por rol).
 *
 * Ejemplo:
 *   @Post()
 *   @RequirePermission('canAccessBanks')
 *   create() { ... }
 */
export const RequirePermission = (
  permission: PermissionKey,
): MethodDecorator & ClassDecorator => SetMetadata(REQUIRE_PERMISSION_KEY, permission);
