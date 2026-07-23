import {
  buildNameResolver,
  resolveMovementNames,
  type AccountNameRow,
} from '../internal/resolve-account-names';

/**
 * Tests unitarios del resolvedor de nombres de cuenta del Resumen de tesorería.
 * Espejo de `placepos/.../__tests__/treasuryHelpers.test.ts`.
 */
const banks: AccountNameRow[] = [
  { id: 1, name: 'Bancolombia' },
  { id: 2, name: 'Davivienda' },
];
const wallets: AccountNameRow[] = [{ id: 10, name: 'Nequi' }];
const registers: AccountNameRow[] = [
  { id: 100, name: 'Juan Pérez' },
  { id: 101, name: null },
  { id: 102, name: '   ' },
];

describe('buildNameResolver', () => {
  const resolve = buildNameResolver(banks, wallets, registers);

  it('resuelve bancos, billeteras y cajas existentes', () => {
    expect(resolve('bank', 1)).toBe('Bancolombia');
    expect(resolve('wallet', 10)).toBe('Nequi');
    expect(resolve('cash_register', 100)).toBe('Juan Pérez');
  });

  it('cae a etiqueta genérica cuando la cuenta no existe', () => {
    expect(resolve('bank', 999)).toBe('Banco');
    expect(resolve('wallet', 999)).toBe('Billetera');
    expect(resolve('cash_register', 999)).toBe('Caja de cajero');
  });

  it('cae a "Caja de cajero" cuando el cajero no tiene nombre', () => {
    expect(resolve('cash_register', 101)).toBe('Caja de cajero');
    expect(resolve('cash_register', 102)).toBe('Caja de cajero');
  });

  it('devuelve null para tipos externos/desconocidos o ids faltantes', () => {
    expect(resolve('external', 5)).toBeNull();
    expect(resolve('unknown', 5)).toBeNull();
    expect(resolve(null, 1)).toBeNull();
    expect(resolve('bank', null)).toBeNull();
  });
});

describe('resolveMovementNames', () => {
  const resolve = buildNameResolver(banks, wallets, registers);

  it('INGRESO: solo destino resuelto', () => {
    expect(
      resolveMovementNames(
        { source_type: null, source_id: null, destination_type: 'cash_register', destination_id: 100 },
        resolve,
      ),
    ).toEqual({ source_name: null, destination_name: 'Juan Pérez' });
  });

  it('EGRESO: solo origen resuelto', () => {
    expect(
      resolveMovementNames(
        { source_type: 'bank', source_id: 1, destination_type: 'external', destination_id: null },
        resolve,
      ),
    ).toEqual({ source_name: 'Bancolombia', destination_name: null });
  });

  it('TRASLADO interno: origen y destino resueltos', () => {
    expect(
      resolveMovementNames(
        { source_type: 'bank', source_id: 2, destination_type: 'wallet', destination_id: 10 },
        resolve,
      ),
    ).toEqual({ source_name: 'Davivienda', destination_name: 'Nequi' });
  });
});
