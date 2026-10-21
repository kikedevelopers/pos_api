import Big from 'big.js';

import {
  accountLabel,
  buildAdjustmentReason,
  classifyTransferRoute,
  MAX_ADJUSTMENT_REASON_LENGTH,
  resolveTreasuryAccount,
  type TreasuryAccount,
} from '../internal/treasury-tool-helpers';

/**
 * Las reglas que deciden DE QUÉ cuenta A QUÉ cuenta se mueve el dinero. Un
 * error aquí mueve plata real de la cuenta equivocada: ante la duda, ambigua
 * o no encontrada (Place pregunta), nunca "la más parecida".
 */

const account = (over: Partial<TreasuryAccount>): TreasuryAccount => ({
  kind: 'wallet',
  id: 1,
  user_id: null,
  name: 'Cuenta',
  account_number: null,
  balance: new Big(0),
  is_own: false,
  ...over,
});

const OWN_CASH = account({
  kind: 'cash_register',
  id: 10,
  user_id: 100,
  name: 'Enrique Pacheco',
  is_own: true,
});
const ANA_CASH = account({ kind: 'cash_register', id: 11, user_id: 101, name: 'Ana Gómez' });
const NEQUI_BANK = account({ kind: 'bank', id: 20, name: 'NEQUI', account_number: '3117323107' });
const BANCOLOMBIA = account({ kind: 'bank', id: 21, name: 'BANCOLOMBIA', account_number: '718' });
const EFECTIVO = account({ kind: 'wallet', id: 30, name: 'Efectivo' });
const CAJA_MAYOR = account({ kind: 'wallet', id: 31, name: 'CAJA MAYOR' });
const CAJA_CHICA = account({ kind: 'wallet', id: 32, name: 'CAJA CHICA' });

const ACCOUNTS = [OWN_CASH, ANA_CASH, NEQUI_BANK, BANCOLOMBIA, EFECTIVO, CAJA_MAYOR, CAJA_CHICA];

const resolved = (
  query: string,
  accounts: TreasuryAccount[] = ACCOUNTS,
): TreasuryAccount | string => {
  const result = resolveTreasuryAccount(query, accounts);
  return result.status === 'ok' ? result.account : result.status;
};

describe('accountLabel', () => {
  it('nombra cada cuenta de forma legible y estable', () => {
    expect(accountLabel(OWN_CASH)).toBe('Mi caja');
    expect(accountLabel(ANA_CASH)).toBe('Caja de Ana Gómez');
    expect(accountLabel(NEQUI_BANK)).toBe('NEQUI - 3117323107');
    expect(accountLabel(EFECTIVO)).toBe('Efectivo');
  });
});

describe('resolveTreasuryAccount', () => {
  it('nombre exacto, sin importar tildes ni mayúsculas', () => {
    expect(resolved('Nequi')).toBe(NEQUI_BANK);
    expect(resolved('  NEQUÍ ')).toBe(NEQUI_BANK);
    expect(resolved('bancolombia')).toBe(BANCOLOMBIA);
  });

  it('con el tipo dicho por el usuario ("banco Nequi", "billetera Efectivo", "del banco nequi")', () => {
    expect(resolved('banco Nequi')).toBe(NEQUI_BANK);
    expect(resolved('del banco nequi')).toBe(NEQUI_BANK);
    expect(resolved('la billetera Efectivo')).toBe(EFECTIVO);
  });

  it('por número de cuenta', () => {
    expect(resolved('3117323107')).toBe(NEQUI_BANK);
  });

  it('"caja", "mi caja", "la caja", "desde mi caja" → la caja PROPIA', () => {
    for (const query of ['caja', 'mi caja', 'la caja', 'desde mi caja', 'caja registradora']) {
      expect(resolved(query)).toBe(OWN_CASH);
    }
  });

  it('una billetera llamada "Efectivo" gana sobre el alias de caja', () => {
    expect(resolved('Efectivo')).toBe(EFECTIVO);
    expect(resolved('efectivo')).toBe(EFECTIVO);
  });

  it('si otra cuenta LLEVA "efectivo" en el nombre, pregunta (no asume la caja)', () => {
    const tienda = account({ kind: 'wallet', id: 40, name: 'Efectivo tienda' });
    const result = resolveTreasuryAccount('efectivo', [OWN_CASH, tienda, NEQUI_BANK]);
    expect(result.status).toBe('ambiguous');
    expect(result.status === 'ambiguous' && result.matches).toEqual([OWN_CASH, tienda]);
  });

  it('nunca toma una cuenta cuyo nombre es solo PARTE de lo que dijo el usuario', () => {
    const juan = account({ kind: 'cash_register', id: 50, user_id: 105, name: 'Juan' });
    expect(resolved('caja de Juan Carlos', [OWN_CASH, juan])).toBe('not_found');
    const bogota = account({ kind: 'bank', id: 51, name: 'Bogotá' });
    expect(resolved('bogota ahorros', [bogota])).toBe('not_found');
    expect(resolved('caja de juan', [OWN_CASH, juan])).toBe(juan);
  });

  it('sin billetera "Efectivo", "efectivo" es la caja propia', () => {
    expect(resolved('efectivo', [OWN_CASH, NEQUI_BANK])).toBe(OWN_CASH);
  });

  it('billeteras que se llaman "Caja …" se resuelven por su nombre completo, no como caja', () => {
    expect(resolved('caja mayor')).toBe(CAJA_MAYOR);
    expect(resolved('CAJA CHICA')).toBe(CAJA_CHICA);
    expect(resolved('chica')).toBe(CAJA_CHICA);
  });

  it('la caja de otro usuario por su nombre ("caja de Ana")', () => {
    expect(resolved('caja de Ana')).toBe(ANA_CASH);
    expect(resolved('la caja de ana gomez')).toBe(ANA_CASH);
    expect(resolved('Caja de Ana Gómez')).toBe(ANA_CASH);
  });

  it('la caja propia también por el nombre del dueño', () => {
    expect(resolved('caja de Enrique')).toBe(OWN_CASH);
  });

  it('el tipo restringe la búsqueda: "billetera Nequi" no toma el BANCO Nequi', () => {
    expect(resolved('billetera Nequi')).toBe('not_found');
  });

  it('dos cuentas con el mismo nombre → ambigua (se pregunta), nunca la primera', () => {
    const nequi_wallet = account({ kind: 'wallet', id: 33, name: 'Nequi' });
    const result = resolveTreasuryAccount('Nequi', [...ACCOUNTS, nequi_wallet]);
    expect(result.status).toBe('ambiguous');
    expect(result.status === 'ambiguous' && result.matches).toEqual([NEQUI_BANK, nequi_wallet]);
    // Con el tipo se desambigua.
    expect(resolved('billetera nequi', [...ACCOUNTS, nequi_wallet])).toBe(nequi_wallet);
  });

  it('parcial con varios candidatos → ambigua', () => {
    expect(resolved('caja', [CAJA_MAYOR, CAJA_CHICA])).toBe('not_found');
    expect(resolveTreasuryAccount('caj', [CAJA_MAYOR, CAJA_CHICA]).status).toBe('ambiguous');
    const two = [
      account({ id: 1, name: 'Ahorro hogar' }),
      account({ id: 2, name: 'Ahorro local' }),
    ];
    expect(resolveTreasuryAccount('ahorro', two).status).toBe('ambiguous');
  });

  it('textos vacíos, cortos o inexistentes → no encontrada', () => {
    for (const query of ['', '   ', 'de la', 'xy', 'Davivienda', 'banco']) {
      expect(resolved(query)).toBe('not_found');
    }
  });

  it('caja propia aún sin crear (no hay fila) también se resuelve si viene en la lista', () => {
    const virtual = account({
      kind: 'cash_register',
      id: 0,
      user_id: 100,
      name: 'Mi caja',
      is_own: true,
    });
    expect(resolved('mi caja', [virtual, NEQUI_BANK])).toBe(virtual);
  });
});

describe('classifyTransferRoute', () => {
  const unsupportedReason = (from: TreasuryAccount, to: TreasuryAccount): string => {
    const route = classifyTransferRoute(from, to);
    return route.status === 'unsupported' ? route.reason : 'ok';
  };

  it('banco/billetera → banco/billetera va por el traslado entre cuentas', () => {
    expect(classifyTransferRoute(NEQUI_BANK, EFECTIVO)).toEqual({
      status: 'ok',
      via: 'accounts',
      source_type: 'bank',
      destination_type: 'wallet',
      destination_id: 30,
    });
    expect(classifyTransferRoute(EFECTIVO, BANCOLOMBIA)).toMatchObject({
      via: 'accounts',
      source_type: 'wallet',
      destination_type: 'bank',
      destination_id: 21,
    });
    expect(classifyTransferRoute(NEQUI_BANK, BANCOLOMBIA)).toMatchObject({ via: 'accounts' });
    expect(classifyTransferRoute(EFECTIVO, CAJA_CHICA)).toMatchObject({ via: 'accounts' });
  });

  it('billetera → caja de OTRO usuario: destino "user" con el user_id del dueño', () => {
    expect(classifyTransferRoute(EFECTIVO, ANA_CASH)).toEqual({
      status: 'ok',
      via: 'accounts',
      source_type: 'wallet',
      destination_type: 'user',
      destination_id: 101,
    });
  });

  it('caja (propia o de otro) → banco/billetera va por el traslado de caja, con su dueño', () => {
    expect(classifyTransferRoute(OWN_CASH, EFECTIVO)).toEqual({
      status: 'ok',
      via: 'cash',
      register_user_id: 100,
      destination_type: 'wallet',
    });
    expect(classifyTransferRoute(ANA_CASH, NEQUI_BANK)).toEqual({
      status: 'ok',
      via: 'cash',
      register_user_id: 101,
      destination_type: 'bank',
    });
  });

  it('rutas que la app no permite se rechazan con la alternativa', () => {
    expect(classifyTransferRoute(NEQUI_BANK, NEQUI_BANK)).toMatchObject({ status: 'unsupported' });
    expect(classifyTransferRoute(OWN_CASH, OWN_CASH)).toMatchObject({ status: 'unsupported' });
    expect(unsupportedReason(OWN_CASH, ANA_CASH)).toContain('billetera');
    expect(unsupportedReason(NEQUI_BANK, ANA_CASH)).toContain('billetera');
    expect(unsupportedReason(EFECTIVO, OWN_CASH)).toContain('propia caja');
  });

  it('desde la caja propia aún sin crear → no hay saldo que mover', () => {
    const virtual = account({ kind: 'cash_register', id: 0, user_id: 100, is_own: true });
    expect(classifyTransferRoute(virtual, EFECTIVO)).toMatchObject({ status: 'unsupported' });
  });
});

describe('buildAdjustmentReason', () => {
  it('sin motivo deja la marca de Place', () => {
    expect(buildAdjustmentReason(undefined)).toBe('Corrección con Place');
    expect(buildAdjustmentReason('   ')).toBe('Corrección con Place');
    expect(buildAdjustmentReason(42)).toBe('Corrección con Place');
  });

  it('con motivo lo recorta y agrega la marca de Place', () => {
    expect(buildAdjustmentReason('  arqueo   del  día ')).toBe('arqueo del día (con Place)');
  });

  it('un motivo demasiado largo se rechaza (no se recorta en silencio)', () => {
    expect(buildAdjustmentReason('x'.repeat(MAX_ADJUSTMENT_REASON_LENGTH))).not.toBeNull();
    expect(buildAdjustmentReason('x'.repeat(MAX_ADJUSTMENT_REASON_LENGTH + 1))).toBeNull();
  });
});
