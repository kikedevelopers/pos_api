import 'reflect-metadata';

import { ROLES_KEY } from '@/common/decorators/roles.decorator';
import { REQUIRE_PERMISSION_KEY } from '@/common/decorators/require-permission.decorator';
import type { UserType } from '@/common/types/jwt-payload.type';

import { CompaniesController } from '../companies.controller';

/**
 * RBAC de `/companies` (metadata, sin DB).
 *
 * `PUT /companies/:id` (editar Mi Negocio) era `@Roles('owner')`: un empleado
 * con rol Administrador no podía guardar cambios. Ahora se gatea por
 * `canAccessSettings` admitiendo al employee (paridad con PlacePos, cuyo
 * `PUT /companies/:id` no exige rol de dueño). El GET sigue abierto a todo
 * autenticado (lo necesita el POS).
 */
type ControllerMethod = keyof CompaniesController;

const rolesOf = (method: ControllerMethod): UserType[] | undefined =>
  Reflect.getMetadata(ROLES_KEY, CompaniesController.prototype[method]);

const permissionOf = (method: ControllerMethod): string | undefined =>
  Reflect.getMetadata(REQUIRE_PERMISSION_KEY, CompaniesController.prototype[method]);

describe('CompaniesController · RBAC metadata', () => {
  it('PUT (update) exige canAccessSettings', () => {
    expect(permissionOf('update')).toBe('canAccessSettings');
  });

  it('PUT (update) admite al employee en @Roles', () => {
    expect(rolesOf('update')).toContain('employee');
  });

  it('GET (getCurrent) sigue abierto al employee (el POS necesita la info del negocio)', () => {
    expect(rolesOf('getCurrent')).toContain('employee');
  });
});
