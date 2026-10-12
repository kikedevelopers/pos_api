import { ConflictException, NotFoundException, UnprocessableEntityException } from '@nestjs/common';

import { Employee } from '@/modules/employees/entities/employee.entity';

import { AssignOrderAction } from '../actions/assign-order.action';
import { SaleInvoice, TicketType } from '../entities/sale-invoice.entity';

type Row = Record<string, unknown> | null;

/**
 * Manager mock: `findOne` resuelve por entidad (la venta y el empleado) y
 * `update` registra la escritura. `dataSource.transaction(cb)` ejecuta `cb` con
 * este manager, igual que en producción.
 */
function buildAction(opts: { sale?: Row; employee?: Row }) {
  const update = jest.fn().mockResolvedValue({ affected: 1 });
  const manager = {
    findOne: jest.fn((entity: unknown): Promise<Row> => {
      if (entity === SaleInvoice) return Promise.resolve(opts.sale ?? null);
      if (entity === Employee) return Promise.resolve(opts.employee ?? null);
      return Promise.resolve(null);
    }),
    update,
  };
  const dataSource = {
    transaction: jest.fn((cb: (m: typeof manager) => unknown) => cb(manager)),
  };
  const action = new AssignOrderAction(dataSource as never);
  return { action, update, manager };
}

const ORDER = {
  id: '100',
  company_id: '7',
  ticket_type: TicketType.ORDER,
  created_by_id: '5',
  assigned_to_user_id: null,
  assigned_to_name: null,
};

const EMPLOYEE = { id: '3', name: 'Carlos Bodega', user_id: '42' };

describe('AssignOrderAction', () => {
  it('asigna un pedido a un empleado con acceso y guarda id + snapshot de nombre', async () => {
    const { action, update } = buildAction({ sale: { ...ORDER }, employee: { ...EMPLOYEE } });

    const result = await action.execute({ invoiceId: 100, companyId: 7, assignedToUserId: 42 });

    expect(result).toEqual({
      id: 100,
      assignedToUserId: 42,
      assignedToName: 'Carlos Bodega',
      previousAssignedToUserId: null,
    });
    expect(update).toHaveBeenCalledWith(
      SaleInvoice,
      { id: '100', company_id: '7' },
      { assigned_to_user_id: '42', assigned_to_name: 'Carlos Bodega' },
    );
  });

  it('desasigna (null) limpiando la asignación y reporta el asignado previo', async () => {
    const { action, update } = buildAction({
      sale: { ...ORDER, assigned_to_user_id: '42', assigned_to_name: 'Carlos Bodega' },
    });

    const result = await action.execute({ invoiceId: 100, companyId: 7, assignedToUserId: null });

    expect(result).toEqual({
      id: 100,
      assignedToUserId: null,
      assignedToName: null,
      previousAssignedToUserId: 42,
    });
    expect(update).toHaveBeenCalledWith(
      SaleInvoice,
      { id: '100', company_id: '7' },
      { assigned_to_user_id: null, assigned_to_name: null },
    );
  });

  it('reasigna reportando el asignado anterior', async () => {
    const { action } = buildAction({
      sale: { ...ORDER, assigned_to_user_id: '9', assigned_to_name: 'Ana' },
      employee: { ...EMPLOYEE },
    });

    const result = await action.execute({ invoiceId: 100, companyId: 7, assignedToUserId: 42 });

    expect(result.previousAssignedToUserId).toBe(9);
    expect(result.assignedToUserId).toBe(42);
  });

  it('404 si el pedido no existe en la company', async () => {
    const { action } = buildAction({ sale: null });
    await expect(
      action.execute({ invoiceId: 100, companyId: 7, assignedToUserId: 42 }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('409 si el ticket ya fue cobrado (SALE): asignación bloqueada', async () => {
    const { action, update } = buildAction({
      sale: { ...ORDER, ticket_type: TicketType.SALE },
      employee: { ...EMPLOYEE },
    });
    await expect(
      action.execute({ invoiceId: 100, companyId: 7, assignedToUserId: 42 }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(update).not.toHaveBeenCalled();
  });

  it('409 si el ticket es un préstamo (LOAN)', async () => {
    const { action } = buildAction({
      sale: { ...ORDER, ticket_type: TicketType.LOAN },
      employee: { ...EMPLOYEE },
    });
    await expect(
      action.execute({ invoiceId: 100, companyId: 7, assignedToUserId: 42 }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('422 si se intenta asignar al creador del pedido', async () => {
    const { action, update } = buildAction({
      sale: { ...ORDER, created_by_id: '42' },
      employee: { ...EMPLOYEE },
    });
    await expect(
      action.execute({ invoiceId: 100, companyId: 7, assignedToUserId: 42 }),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
    expect(update).not.toHaveBeenCalled();
  });

  it('422 si el empleado no existe o no tiene acceso al sistema', async () => {
    const { action, update } = buildAction({ sale: { ...ORDER }, employee: null });
    await expect(
      action.execute({ invoiceId: 100, companyId: 7, assignedToUserId: 42 }),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
    expect(update).not.toHaveBeenCalled();
  });

  it('exige lock pesimista y venta activa (requireActive) al localizar el pedido', async () => {
    const { action, manager } = buildAction({ sale: { ...ORDER }, employee: { ...EMPLOYEE } });
    await action.execute({ invoiceId: 100, companyId: 7, assignedToUserId: 42 });
    expect(manager.findOne).toHaveBeenCalledWith(
      SaleInvoice,
      expect.objectContaining({
        where: { id: '100', company_id: '7', is_deleted: false },
        lock: { mode: 'pessimistic_write' },
      }),
    );
  });
});
