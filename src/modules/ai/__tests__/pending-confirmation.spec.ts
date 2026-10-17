import {
  hashMessage,
  isExplicitConfirmation,
  type AiToolRequestContext,
} from '../internal/expense-tool-helpers';
import {
  checkPendingConfirmation,
  EXPENSE_ACTION_TYPES,
  type PendingConfirmationRow,
} from '../internal/pending-confirmation';

/**
 * El guard que comparten gastos y pedidos: nada se ejecuta sin el "sí" del
 * usuario, en una petición posterior, respondiendo a ESE resumen.
 */
describe('checkPendingConfirmation', () => {
  const TRIGGER = 'véndele a Juan 2 libras de fécula de maíz';
  const pending = (over: Partial<PendingConfirmationRow> = {}): PendingConfirmationRow => ({
    action_type: 'CREATE_SALE',
    request_id: 'req-prepare',
    trigger_message_hash: hashMessage(TRIGGER),
    is_expired: false,
    ...over,
  });
  const context = (
    current: string,
    previous: string | null = TRIGGER,
    request_id = 'req-confirm',
  ): AiToolRequestContext => ({
    request_id,
    current_user_message: current,
    previous_user_message: previous,
  });

  it('"sí" en la petición siguiente, respondiendo al resumen → procede', () => {
    expect(checkPendingConfirmation(pending(), context('sí'))).toBeNull();
    expect(checkPendingConfirmation(pending(), context('Sí, factúralo por favor'))).toBeNull();
  });

  it('misma petición que la preparó → espera al usuario (sin vencerla)', () => {
    expect(
      checkPendingConfirmation(pending(), context('sí', TRIGGER, 'req-prepare')),
    ).toMatchObject({
      status: 'awaiting_user_reply',
      expire: false,
    });
  });

  it('vencida → expired', () => {
    expect(checkPendingConfirmation(pending({ is_expired: true }), context('sí'))).toMatchObject({
      status: 'expired',
      expire: true,
    });
  });

  it('el "sí" responde a OTRO mensaje (o no hay secuencia) → stale', () => {
    expect(checkPendingConfirmation(pending(), context('sí', 'otra cosa'))).toMatchObject({
      status: 'stale_confirmation',
      expire: true,
    });
    expect(checkPendingConfirmation(pending(), context('sí', null))).toMatchObject({
      status: 'stale_confirmation',
    });
  });

  it.each([
    'no',
    'sí pero 3 libras',
    'sí, a nombre de Pedro',
    '¿cuánto queda?',
    'mejor la media libra',
  ])('"%s" no es un sí explícito → no procede', (message) => {
    expect(checkPendingConfirmation(pending(), context(message))).toMatchObject({
      status: 'confirmation_not_explicit',
      expire: true,
    });
  });

  it('vocabulario de pedidos: "créalo", "sí, el pedido", "dale, la venta", "de una"', () => {
    for (const message of [
      'créalo',
      'sí, el pedido',
      'dale, la venta',
      'factúrelo',
      'ok móntalo',
      'de una',
    ]) {
      expect(isExplicitConfirmation(message, 'sale')).toBe(true);
    }
  });

  it('cada operación tiene SU vocabulario: "factúralo" no confirma un gasto, "archívalo" no confirma un pedido', () => {
    expect(isExplicitConfirmation('factúralo', 'expense')).toBe(false);
    expect(isExplicitConfirmation('sí, el pedido', 'expense')).toBe(false);
    expect(isExplicitConfirmation('archívalo', 'sale')).toBe(false);
    expect(isExplicitConfirmation('sí, el gasto', 'sale')).toBe(false);
    expect(isExplicitConfirmation('archívalo', 'expense')).toBe(true);
  });

  it('"una" suelta (o "solo una") ya NO confirma: puede ser una corrección de cantidad', () => {
    for (const kind of ['sale', 'expense'] as const) {
      expect(isExplicitConfirmation('una', kind)).toBe(false);
      expect(isExplicitConfirmation('solo una', kind)).toBe(false);
      expect(isExplicitConfirmation('de una', kind)).toBe(true);
    }
  });

  it('el guard usa el vocabulario del tipo de la pendiente', () => {
    const expense = pending({ action_type: 'REGISTER_EXPENSE' });
    expect(checkPendingConfirmation(expense, context('factúralo'))).toMatchObject({
      status: 'confirmation_not_explicit',
    });
    expect(checkPendingConfirmation(pending(), context('factúralo'))).toBeNull();
  });

  it('los tipos de gasto no incluyen el de pedido', () => {
    expect(EXPENSE_ACTION_TYPES.has('REGISTER_EXPENSE')).toBe(true);
    expect(EXPENSE_ACTION_TYPES.has('VOID_EXPENSE')).toBe(true);
    expect(EXPENSE_ACTION_TYPES.has('CREATE_SALE')).toBe(false);
  });
});
