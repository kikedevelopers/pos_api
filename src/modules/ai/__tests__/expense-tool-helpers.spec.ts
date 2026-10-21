import Big from 'big.js';

import {
  extractRequestContext,
  hashMessage,
  isExplicitConfirmation,
  MAX_EXPENSE_DESCRIPTION_LENGTH,
  normalizeText,
  readDescriptionArg,
  readMoneyArg,
  resolveExpenseSource,
  type ExpenseSourceOption,
} from '../internal/expense-tool-helpers';
import type { ChatTurn } from '../internal/gemini.types';

/**
 * Reglas puras de las herramientas que ESCRIBEN gastos. Cada caso de aquí es un
 * peso mal movido si falla: un "50.000" leído como 50, un "sí, pero de 60 mil"
 * tomado como confirmación, o una fuente adivinada.
 */

describe('readMoneyArg', () => {
  const read = (amount: unknown): ReturnType<typeof readMoneyArg> =>
    readMoneyArg({ amount }, 'amount');

  it.each([
    [50000, '50000'],
    [1200000, '1200000'],
    [150.5, '150.5'],
    [0.01, '0.01'],
    ['50000', '50000'],
    ['$50000', '50000'],
    ['$ 75000.25', '75000.25'],
    ['  9800 ', '9800'],
  ])('acepta %p como %s', (input, expected) => {
    const result = read(input);
    expect(result.status).toBe('ok');
    expect(result.status === 'ok' && result.amount.eq(new Big(expected))).toBe(true);
  });

  it.each([undefined, null, '', '   '])('sin valor (%p) → missing', (input) => {
    expect(read(input)).toEqual({ status: 'missing' });
  });

  it.each([
    // El punto de miles colombiano: parseFloat daría 50 pesos.
    '50.000',
    '1.200.000',
    '50,000',
    '1.500,50',
    '50 mil',
    'cincuenta mil',
    '50k',
    '-50000',
    '50000.123',
    'abc',
  ])('rechaza el string ambiguo o inválido %p', (input) => {
    expect(read(input).status).toBe('invalid');
  });

  it.each([0, -1, -50000, Number.NaN, Number.POSITIVE_INFINITY, 10.555, 1e16])(
    'rechaza el número %p',
    (input) => {
      expect(read(input).status).toBe('invalid');
    },
  );

  it.each([true, {}, [50000]])('rechaza tipos raros (%p)', (input) => {
    expect(read(input).status).toBe('invalid');
  });

  it('acepta justo el tope de numeric(15,2) y rechaza lo que lo pasa', () => {
    expect(read('9999999999999.99').status).toBe('ok');
    expect(read(99999999999999).status).toBe('invalid');
  });
});

describe('readDescriptionArg', () => {
  const read = (description: unknown): ReturnType<typeof readDescriptionArg> =>
    readDescriptionArg({ description }, 'description');

  it('recorta y colapsa espacios, conservando el texto del usuario', () => {
    expect(read('  Pago   de luz  ')).toEqual({ status: 'ok', description: 'Pago de luz' });
  });

  it.each([
    undefined,
    null,
    42,
    '',
    '   ',
    'gasto',
    'GASTO',
    'Gastos varios',
    'x',
    'N/A',
    'sin concepto',
    'Concepto',
    'prueba',
  ])('un concepto vacío o de relleno (%p) cuenta como faltante', (input) => {
    expect(read(input)).toEqual({ status: 'missing' });
  });

  it('rechaza conceptos más largos que el DTO de gastos', () => {
    expect(read('a'.repeat(MAX_EXPENSE_DESCRIPTION_LENGTH)).status).toBe('ok');
    expect(read('a'.repeat(MAX_EXPENSE_DESCRIPTION_LENGTH + 1)).status).toBe('invalid');
  });
});

describe('resolveExpenseSource', () => {
  const option = (over: Partial<ExpenseSourceOption>): ExpenseSourceOption => ({
    source_type: 'bank',
    source_id: 1,
    label: 'X',
    name: 'X',
    account_number: null,
    balance: new Big(0),
    ...over,
  });
  const CASH = option({ source_type: 'cash_register', source_id: 10, label: 'Caja', name: 'Caja' });
  const BANCOLOMBIA = option({
    source_type: 'bank',
    source_id: 20,
    label: 'Bancolombia - 1234',
    name: 'Bancolombia',
    account_number: '1234',
  });
  const DAVIVIENDA = option({
    source_type: 'bank',
    source_id: 21,
    label: 'Davivienda - 9876',
    name: 'Davivienda',
    account_number: '9876',
  });
  const NEQUI = option({ source_type: 'wallet', source_id: 30, label: 'Nequi', name: 'Nequi' });
  const SOURCES = [CASH, BANCOLOMBIA, DAVIVIENDA, NEQUI];

  const resolved = (query: string, sources = SOURCES): number | string => {
    const result = resolveExpenseSource(query, sources);
    return result.status === 'ok' ? result.source.source_id : result.status;
  };

  it.each([
    'caja',
    'Caja',
    'la caja',
    'desde la caja',
    'de mi caja',
    'efectivo',
    'caja registradora',
  ])('"%s" es la caja del usuario', (query) => {
    expect(resolved(query)).toBe(10);
  });

  it('encuentra bancos y billeteras por nombre, sin tildes ni mayúsculas', () => {
    expect(resolved('BANCOLOMBIA')).toBe(20);
    expect(resolved('del banco Davivienda')).toBe(21);
    expect(resolved('néqui')).toBe(30);
    expect(resolved('Bancolombia - 1234')).toBe(20);
    expect(resolved('9876')).toBe(21);
  });

  it('acepta coincidencia parcial solo si señala UNA cuenta', () => {
    expect(resolved('Bancolombia ahorros')).toBe(20);
    expect(resolved('davi')).toBe(21);
  });

  it('dos cuentas con el mismo nombre → ambiguo (no se adivina)', () => {
    const other = option({
      source_type: 'bank',
      source_id: 22,
      label: 'Bancolombia - 5555',
      name: 'Bancolombia',
      account_number: '5555',
    });
    const result = resolveExpenseSource('Bancolombia', [...SOURCES, other]);
    expect(result.status).toBe('ambiguous');
    expect(result.status === 'ambiguous' && result.matches.map((m) => m.source_id)).toEqual([
      20, 22,
    ]);
    // Con el número de cuenta sí es una sola.
    expect(resolved('Bancolombia - 5555', [...SOURCES, other])).toBe(22);
  });

  it('la coincidencia exacta gana sobre la parcial ("Caja fuerte" no es la caja)', () => {
    const safe = option({
      source_type: 'wallet',
      source_id: 31,
      label: 'Caja fuerte',
      name: 'Caja fuerte',
    });
    expect(resolved('caja fuerte', [...SOURCES, safe])).toBe(31);
    expect(resolved('caja', [...SOURCES, safe])).toBe(10);
  });

  it('una billetera llamada "Efectivo" choca con el alias de la caja → ambiguo', () => {
    const wallet = option({
      source_type: 'wallet',
      source_id: 32,
      label: 'Efectivo',
      name: 'Efectivo',
    });
    expect(resolved('efectivo', [...SOURCES, wallet])).toBe('ambiguous');
  });

  it('una parcial que señala varias cuentas es ambigua', () => {
    expect(
      resolved('banco', [
        BANCOLOMBIA,
        option({
          source_id: 40,
          label: 'Banco de Bogotá - 1',
          name: 'Banco de Bogotá',
          account_number: '1',
        }),
      ]),
    ).toBe('ambiguous');
  });

  it.each(['', '   ', 'Bitcoin', 'ba', 'de'])('"%s" no se resuelve a ninguna cuenta', (query) => {
    expect(resolved(query)).toBe('not_found');
  });
});

describe('isExplicitConfirmation', () => {
  it.each([
    'sí',
    'Si',
    'SÍ.',
    'si!',
    'sí, por favor',
    'Sí señor',
    'confirmo',
    'Confirmado',
    'dale',
    'ok',
    'Okey',
    'listo',
    'hazlo',
    'de acuerdo',
    'está bien',
    'correcto',
    'perfecto, gracias',
    'adelante',
    'de una',
    'sí, regístralo',
    'sí, archívalo',
    'si place hazlo',
    '👍 sí',
  ])('"%s" confirma', (message) => {
    expect(isExplicitConfirmation(message)).toBe(true);
  });

  it.each([
    'no',
    'No, espera',
    'mejor no',
    'cancela',
    'sí pero de 60 mil',
    'sí, pero desde Nequi',
    'si 50000',
    'si, desde la caja',
    '¿de qué caja sale?',
    'registra un gasto de 20000 por almuerzo',
    'gracias',
    'por favor',
    '',
    '   ',
    '👍',
    'sí sí sí sí sí sí sí sí sí',
  ])('"%s" NO confirma', (message) => {
    expect(isExplicitConfirmation(message)).toBe(false);
  });

  it('tolera null/undefined sin lanzar', () => {
    expect(isExplicitConfirmation(null)).toBe(false);
    expect(isExplicitConfirmation(undefined)).toBe(false);
  });
});

describe('normalizeText / hashMessage', () => {
  it('normaliza tildes, mayúsculas y signos', () => {
    expect(normalizeText('  ¡Sí, SEÑOR!  ')).toBe('si senor');
  });

  it('la huella ignora espacios de más pero distingue el contenido', () => {
    expect(hashMessage('registra  50000 de luz ')).toBe(hashMessage('registra 50000 de luz'));
    expect(hashMessage('registra 50000 de luz')).not.toBe(hashMessage('registra 60000 de luz'));
    expect(hashMessage('x')).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('extractRequestContext', () => {
  const turn = (role: ChatTurn['role'], content: string): ChatTurn => ({ role, content });

  it('usuario → Place → usuario: actual y anterior', () => {
    const context = extractRequestContext(
      [
        turn('user', 'hola'),
        turn('assistant', 'hola!'),
        turn('user', 'registra 50000 de luz desde caja'),
        turn('assistant', 'Resumen… ¿confirmas?'),
        turn('user', 'sí'),
      ],
      'req-1',
    );
    expect(context).toEqual({
      request_id: 'req-1',
      current_user_message: 'sí',
      previous_user_message: 'registra 50000 de luz desde caja',
    });
  });

  it('dos mensajes seguidos del usuario: no hay "anterior" válido', () => {
    const context = extractRequestContext(
      [turn('user', 'registra 50000 de luz'), turn('user', 'sí')],
      'req-2',
    );
    expect(context.current_user_message).toBe('sí');
    expect(context.previous_user_message).toBeNull();
  });

  it('si el último turno no es del usuario no hay mensaje actual', () => {
    const context = extractRequestContext(
      [turn('user', 'registra'), turn('assistant', 'resumen')],
      'req-3',
    );
    expect(context.current_user_message).toBeNull();
    expect(context.previous_user_message).toBeNull();
  });

  it('ignora turnos vacíos y basura', () => {
    const context = extractRequestContext(
      [
        turn('user', 'registra 1000 de pan desde caja'),
        turn('assistant', '   '),
        turn('assistant', 'Resumen'),
        { role: 'system', content: 'x' } as unknown as ChatTurn,
        turn('user', 'sí'),
      ],
      'req-4',
    );
    expect(context.previous_user_message).toBe('registra 1000 de pan desde caja');
  });

  it('historial vacío o inválido', () => {
    expect(extractRequestContext([], 'r')).toEqual({
      request_id: 'r',
      current_user_message: null,
      previous_user_message: null,
    });
    expect(
      extractRequestContext(null as unknown as ChatTurn[], 'r').current_user_message,
    ).toBeNull();
  });
});

describe('readMoneyArg · saldo objetivo (allow_zero)', () => {
  it('acepta 0 solo con allow_zero', () => {
    const zero = readMoneyArg({ v: 0 }, 'v', { allow_zero: true });
    expect(zero.status === 'ok' && zero.amount.eq(0)).toBe(true);
    expect(readMoneyArg({ v: '0' }, 'v', { allow_zero: true }).status).toBe('ok');
    expect(readMoneyArg({ v: 0 }, 'v').status).toBe('invalid');
  });

  it('nunca acepta negativos ni separadores de miles, con o sin allow_zero', () => {
    const negative = readMoneyArg({ v: -1 }, 'v', { allow_zero: true });
    expect(negative.status === 'invalid' && negative.reason).toContain('negativo');
    expect(readMoneyArg({ v: '10.000' }, 'v', { allow_zero: true }).status).toBe('invalid');
  });
});
