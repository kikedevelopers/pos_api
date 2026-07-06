import { resolveCashVisibilityOnRoleChange } from '../cash-visibility';

// Default de Cajero: al asignar (transición) el rol Cajero se activa; en
// cualquier otro caso NO se toca (respeta el OFF explícito del admin). Ids son
// strings (bigint). Paridad PlacePos.
describe('resolveCashVisibilityOnRoleChange', () => {
  const CAJERO = '7';

  it('transición a Cajero (rol previo distinto) → true', () => {
    expect(resolveCashVisibilityOnRoleChange('7', null, CAJERO)).toBe(true);
    expect(resolveCashVisibilityOnRoleChange('7', '3', CAJERO)).toBe(true);
  });

  it('ya era Cajero (sin transición) → undefined (no tocar)', () => {
    expect(resolveCashVisibilityOnRoleChange('7', '7', CAJERO)).toBeUndefined();
  });

  it('rol nuevo NO es Cajero → undefined (respeta decisión previa)', () => {
    expect(resolveCashVisibilityOnRoleChange('3', null, CAJERO)).toBeUndefined();
    expect(resolveCashVisibilityOnRoleChange(null, '7', CAJERO)).toBeUndefined();
    expect(resolveCashVisibilityOnRoleChange(undefined, '7', CAJERO)).toBeUndefined();
  });

  it('sin rol Cajero sembrado (cajeroRoleId null) → undefined siempre', () => {
    expect(resolveCashVisibilityOnRoleChange('7', null, null)).toBeUndefined();
  });
});
