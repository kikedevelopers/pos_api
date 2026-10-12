import { ForbiddenException } from '@nestjs/common';
import type { Repository } from 'typeorm';

import { AssertNotAssignedViewerAction } from '../actions/assert-not-assigned-viewer.action';
import type { SaleInvoice } from '../entities/sale-invoice.entity';

type Row = Partial<SaleInvoice> | null;

/**
 * Repo mock: `findOne` resuelve la fila (o null). Registramos la llamada para
 * poder afirmar que un `actorUserId` nulo NO llega a tocar la base.
 */
function buildAction(row: Row) {
  const findOne = jest.fn().mockResolvedValue(row);
  const repo = { findOne } as unknown as Repository<SaleInvoice>;
  const action = new AssertNotAssignedViewerAction(repo);
  return { action, findOne };
}

// Pedido creado por el user 5. "DIANA" (user 42) es la asignada.
const ASSIGNED_TO_42: Row = {
  id: '100',
  created_by_id: '5',
  assigned_to_user_id: '42',
};

describe('AssertNotAssignedViewerAction', () => {
  it('bloquea (403 ASSIGNED_VIEWER_READONLY) al asignado que no es el creador', async () => {
    const { action } = buildAction({ ...ASSIGNED_TO_42 });
    expect.assertions(2);
    try {
      await action.execute({ saleId: 100, companyId: 7, actorUserId: 42 });
    } catch (err) {
      expect(err).toBeInstanceOf(ForbiddenException);
      expect((err as ForbiddenException).getResponse()).toMatchObject({
        payload: { code: 'ASSIGNED_VIEWER_READONLY' },
      });
    }
  });

  it('permite al CREADOR del pedido (aunque esté asignado a otro)', async () => {
    const { action } = buildAction({
      id: '100',
      created_by_id: '5',
      assigned_to_user_id: '42',
    });
    await expect(
      action.execute({ saleId: 100, companyId: 7, actorUserId: 5 }),
    ).resolves.toBeUndefined();
  });

  it('permite a un tercero que NO es el asignado (p. ej. cajero/admin cobrando)', async () => {
    const { action } = buildAction({ ...ASSIGNED_TO_42 });
    await expect(
      action.execute({ saleId: 100, companyId: 7, actorUserId: 9 }),
    ).resolves.toBeUndefined();
  });

  it('permite cuando el pedido NO tiene asignación', async () => {
    const { action } = buildAction({
      id: '100',
      created_by_id: '5',
      assigned_to_user_id: null,
    });
    await expect(
      action.execute({ saleId: 100, companyId: 7, actorUserId: 42 }),
    ).resolves.toBeUndefined();
  });

  it('caso límite: asignado === creador (combo improbable) NO bloquea', async () => {
    const { action } = buildAction({
      id: '100',
      created_by_id: '42',
      assigned_to_user_id: '42',
    });
    await expect(
      action.execute({ saleId: 100, companyId: 7, actorUserId: 42 }),
    ).resolves.toBeUndefined();
  });

  it('sin actorUserId identificable: es no-op y NO consulta la base', async () => {
    const { action, findOne } = buildAction({ ...ASSIGNED_TO_42 });
    await expect(
      action.execute({ saleId: 100, companyId: 7, actorUserId: null }),
    ).resolves.toBeUndefined();
    expect(findOne).not.toHaveBeenCalled();
  });

  it('pedido inexistente: no-op (deja que la operación real devuelva 404)', async () => {
    const { action } = buildAction(null);
    await expect(
      action.execute({ saleId: 999, companyId: 7, actorUserId: 42 }),
    ).resolves.toBeUndefined();
  });
});
