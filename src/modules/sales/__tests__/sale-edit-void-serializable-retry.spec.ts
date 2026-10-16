import type { DataSource } from 'typeorm';

import type { FinancialMovementsService } from '@/modules/financial-movements/financial-movements.service';
import type { IncrementTicketNumberAction } from '@/modules/ticket-settings/actions/increment-ticket-number.action';

import { UpdateSaleAction } from '../actions/update-sale.action';
import type { UpdateSaleDto } from '../dto/update-sale.dto';
import { VoidSaleAction } from '../actions/void-sale.action';

/**
 * Editar/anular corren en SERIALIZABLE: Postgres puede abortar con 40001
 * (serialization_failure) aunque el código sea correcto. Antes el error subía
 * como 500; ahora la transacción COMPLETA se reintenta (relee todo desde cero).
 */
const serializationFailure = (): Error =>
  Object.assign(new Error('could not serialize access'), { code: '40001' });

function dataSourceFailing(times: number, error: () => Error = serializationFailure) {
  let calls = 0;
  const transaction = jest.fn((_iso: string, _cb: unknown) => {
    calls += 1;
    return calls <= times ? Promise.reject(error()) : Promise.resolve({ ok: true, calls });
  });
  return { ds: { transaction } as unknown as DataSource, transaction };
}

const deps = (): [IncrementTicketNumberAction, FinancialMovementsService] => [
  {} as IncrementTicketNumberAction,
  {} as FinancialMovementsService,
];
const ACTOR = { id: 1, fullName: 'E2E', type: 'owner' };

describe('UpdateSaleAction / VoidSaleAction — reintento ante 40001', () => {
  it('UpdateSaleAction reintenta y termina bien tras 2 fallos de serialización', async () => {
    const { ds, transaction } = dataSourceFailing(2);
    const action = new UpdateSaleAction(ds, ...deps());

    await expect(action.execute(1, {} as UpdateSaleDto, 1, ACTOR)).resolves.toEqual({
      ok: true,
      calls: 3,
    });
    expect(transaction).toHaveBeenCalledTimes(3);
    expect(transaction.mock.calls.every((c) => c[0] === 'SERIALIZABLE')).toBe(true);
  });

  it('UpdateSaleAction se rinde tras agotar los reintentos y propaga el 40001', async () => {
    const { ds, transaction } = dataSourceFailing(99);
    const action = new UpdateSaleAction(ds, ...deps());

    await expect(action.execute(1, {} as UpdateSaleDto, 1, ACTOR)).rejects.toMatchObject({
      code: '40001',
    });
    expect(transaction).toHaveBeenCalledTimes(7); // 1 + 6 reintentos
  });

  it('UpdateSaleAction NO reintenta errores de negocio (se propagan al primer intento)', async () => {
    const { ds, transaction } = dataSourceFailing(1, () => new Error('MARGIN_BELOW_MIN'));
    const action = new UpdateSaleAction(ds, ...deps());

    await expect(action.execute(1, {} as UpdateSaleDto, 1, ACTOR)).rejects.toThrow(
      'MARGIN_BELOW_MIN',
    );
    expect(transaction).toHaveBeenCalledTimes(1);
  });

  it('VoidSaleAction reintenta ante 40001', async () => {
    const { ds, transaction } = dataSourceFailing(1);
    const action = new VoidSaleAction(ds, ...deps());

    await expect(action.execute(1, 1, ACTOR)).resolves.toEqual({ ok: true, calls: 2 });
    expect(transaction).toHaveBeenCalledTimes(2);
  });
});
