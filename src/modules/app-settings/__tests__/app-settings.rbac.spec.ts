import 'reflect-metadata';

import { ROLES_KEY } from '@/common/decorators/roles.decorator';
import { REQUIRE_PERMISSION_KEY } from '@/common/decorators/require-permission.decorator';
import type { UserType } from '@/common/types/jwt-payload.type';

import { AppSettingsController } from '../app-settings.controller';

/**
 * RBAC de `/app-settings` (metadata, sin DB).
 *
 * Fija que TODOS los endpoints de configuración —incluidos los GET— admiten al
 * `employee` y exigen `canAccessSettings`. Antes, los GET eran `@Roles('owner',
 * 'manager')` sin `@RequirePermission`, así que el `RolesGuard` rechazaba por
 * TIPO a un empleado con rol Administrador (403 "Usuario sin permisos para esta
 * acción") al abrir la sección P.O.S de Configuraciones. Este test evita la
 * regresión: el gate de un empleado debe ser el PERMISO, no el tipo.
 */
type ControllerMethod = keyof AppSettingsController;

const rolesOf = (method: ControllerMethod): UserType[] | undefined =>
  Reflect.getMetadata(ROLES_KEY, AppSettingsController.prototype[method]);

const permissionOf = (method: ControllerMethod): string | undefined =>
  Reflect.getMetadata(REQUIRE_PERMISSION_KEY, AppSettingsController.prototype[method]);

// Todos los handlers de app-settings (lecturas y escrituras) deben gatearse por
// permiso y admitir empleados.
const SETTINGS_ENDPOINTS: ControllerMethod[] = [
  'getPosMargins',
  'upsertPosMargins',
  'getStrictInventory',
  'upsertStrictInventory',
  'getCustomerPoints',
  'upsertCustomerPoints',
  'getIncludeOrdersInReports',
  'upsertIncludeOrdersInReports',
  'findAll',
  'findOne',
  'upsert',
];

describe('AppSettingsController · RBAC metadata', () => {
  it.each(SETTINGS_ENDPOINTS)('%s exige canAccessSettings', (method) => {
    expect(permissionOf(method)).toBe('canAccessSettings');
  });

  it.each(SETTINGS_ENDPOINTS)('%s admite al employee en @Roles', (method) => {
    expect(rolesOf(method)).toContain('employee');
  });

  it('los GET de lectura ya no rechazan al empleado por tipo (regresión del bug P.O.S)', () => {
    for (const getter of ['getPosMargins', 'getStrictInventory', 'getCustomerPoints'] as const) {
      expect(rolesOf(getter)).toContain('employee');
      expect(permissionOf(getter)).toBe('canAccessSettings');
    }
  });

  it('los PUT de flags de negocio (strict-inventory, include-orders) admiten owner/superadmin, no manager', () => {
    for (const setter of ['upsertStrictInventory', 'upsertIncludeOrdersInReports'] as const) {
      const roles = rolesOf(setter);
      expect(roles).toContain('owner');
      expect(roles).toContain('superadmin');
      expect(roles).not.toContain('manager');
    }
  });
});
