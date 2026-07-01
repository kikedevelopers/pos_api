import { resolveRoleIdOnCreate, resolveRoleIdOnGrantAccess } from '../role-assignment';

/**
 * Regla de negocio: «un rol SOLO tiene sentido con acceso al sistema; al
 * conceder acceso sin rol explícito, se asigna 'Vendedor' por defecto».
 * `VENDEDOR` simula el id (bigint→string) del rol por defecto sembrado;
 * `CUSTOM` un rol explícito elegido por el owner.
 */
const VENDEDOR = '7';
const CUSTOM = '42';

describe('resolveRoleIdOnCreate', () => {
  it('sin acceso (login_enabled=false) → null aunque venga un rol explícito', () => {
    expect(resolveRoleIdOnCreate(false, CUSTOM, VENDEDOR)).toBeNull();
    expect(resolveRoleIdOnCreate(false, null, VENDEDOR)).toBeNull();
  });

  it('con acceso + rol explícito → respeta ese rol (no default)', () => {
    expect(resolveRoleIdOnCreate(true, CUSTOM, VENDEDOR)).toBe(CUSTOM);
  });

  it('con acceso sin rol explícito → asigna el default "Vendedor"', () => {
    expect(resolveRoleIdOnCreate(true, null, VENDEDOR)).toBe(VENDEDOR);
  });

  it('con acceso, sin rol y sin default sembrado (edge) → null (permisos legacy)', () => {
    expect(resolveRoleIdOnCreate(true, null, null)).toBeNull();
  });
});

describe('resolveRoleIdOnGrantAccess', () => {
  it('habilitar acceso a un empleado SIN rol → asigna el default "Vendedor"', () => {
    expect(resolveRoleIdOnGrantAccess(true, null, VENDEDOR)).toBe(VENDEDOR);
  });

  it('habilitar acceso a un empleado CON rol → no toca el rol (undefined)', () => {
    expect(resolveRoleIdOnGrantAccess(true, CUSTOM, VENDEDOR)).toBeUndefined();
  });

  it('deshabilitar acceso → nunca toca el rol (undefined)', () => {
    expect(resolveRoleIdOnGrantAccess(false, null, VENDEDOR)).toBeUndefined();
    expect(resolveRoleIdOnGrantAccess(false, CUSTOM, VENDEDOR)).toBeUndefined();
  });

  it('habilitar sin rol pero sin default sembrado (edge) → no toca (undefined)', () => {
    expect(resolveRoleIdOnGrantAccess(true, null, null)).toBeUndefined();
  });
});
