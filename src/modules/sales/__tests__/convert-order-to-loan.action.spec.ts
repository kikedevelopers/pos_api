import { ForbiddenException } from '@nestjs/common';
import { QueryFailedError, type DataSource } from 'typeorm';

import type { GetEnableThirdPartyLoanAction } from '@/modules/app-settings/actions/get-enable-third-party-loan.action';

// --------------------------------------------------------------------------
// Mocks de helpers de módulo. Interceptamos `adjustInventory` y
// `recordSaleStatus` para observar/forzar su comportamiento sin tocar
// inventario ni historial reales. `InsufficientStockError` se mantiene REAL
// (requireActual) para poder verificar que se propaga tal cual.
// --------------------------------------------------------------------------
jest.mock('@/modules/products/internal/adjust-inventory.helper', () => {
  const actual = jest.requireActual('@/modules/products/internal/adjust-inventory.helper');
  return { ...actual, adjustInventory: jest.fn().mockResolvedValue(undefined) };
});
jest.mock('../internal/record-sale-status.helper', () => ({
  recordSaleStatus: jest.fn().mockResolvedValue(undefined),
}));

import {
  adjustInventory,
  InsufficientStockError,
} from '@/modules/products/internal/adjust-inventory.helper';

import { ConvertOrderToLoanAction } from '../actions/convert-order-to-loan.action';
import { SaleStatusEventType } from '../entities/sale-status-history.entity';
import { TicketType } from '../entities/sale-invoice.entity';
import { recordSaleStatus } from '../internal/record-sale-status.helper';
import type { ProcessLoanActor } from '../actions/convert-order-to-loan.action';
import type { ProcessLoanDto } from '../dto/process-loan.dto';

const adjustInventoryMock = adjustInventory as jest.MockedFunction<typeof adjustInventory>;
const recordSaleStatusMock = recordSaleStatus as jest.MockedFunction<typeof recordSaleStatus>;

const OWNER: ProcessLoanActor = { id: 7, fullName: 'Owner Test', type: 'owner' };
const OP_ID = '550e8400-e29b-41d4-a716-446655440000';
const COMPANY_ID = 42;
const INVOICE_ID = 142;

interface SaleRow {
  id: string;
  company_id: string;
  ticket_type: TicketType;
  ticket_number: string;
  sale_number: string | null;
  customer_id: string | null;
  client_operation_id: string | null;
  is_deleted: boolean;
}

/**
 * Tests de `ConvertOrderToLoanAction` (préstamo de mercancía a un tercero).
 *
 * Cubrimos happy path + todos los malos: no-owner (403), setting off (403
 * fail-closed), factura no encontrada, no es pedido, sin cliente, stock
 * insuficiente con/sin override, e idempotencia (fast-path, carrera in-TX y
 * unique_violation). Y que NO se toca dinero (sin pagos/crédito/caja/puntos).
 */
describe('ConvertOrderToLoanAction', () => {
  let action: ConvertOrderToLoanAction;
  let getLoanEnabledMock: jest.Mock;
  let managerFindOne: jest.Mock;
  let managerUpdate: jest.Mock;
  let managerFind: jest.Mock;
  let repoFindOne: jest.Mock;
  let transactionSpy: jest.Mock;

  // Estado configurable por test.
  let saleInTx: SaleRow | null;
  let existingLoan: Pick<SaleRow, 'id' | 'ticket_number'> | null;
  let lines: Array<Record<string, unknown>>;
  let loanEnabled: boolean;

  function baseOrder(over: Partial<SaleRow> = {}): SaleRow {
    return {
      id: String(INVOICE_ID),
      company_id: String(COMPANY_ID),
      ticket_type: TicketType.ORDER,
      ticket_number: 'PED-100',
      sale_number: null,
      customer_id: '5',
      client_operation_id: null,
      is_deleted: false,
      ...over,
    };
  }

  beforeEach(() => {
    jest.clearAllMocks();
    saleInTx = baseOrder();
    existingLoan = null;
    lines = [{ product_id: '11', quantity: 2, packaging_value: 1, combo_recipe: null }];
    loanEnabled = true;

    managerFindOne = jest.fn(() => Promise.resolve(saleInTx));
    managerUpdate = jest.fn(() => Promise.resolve({ affected: 1 }));
    managerFind = jest.fn(() => Promise.resolve(lines));
    const managerMock = {
      findOne: managerFindOne,
      update: managerUpdate,
      find: managerFind,
    };

    repoFindOne = jest.fn(() => Promise.resolve(existingLoan));
    transactionSpy = jest.fn((_level: unknown, cb: (m: unknown) => unknown) => cb(managerMock));

    const dataSourceMock = {
      getRepository: jest.fn(() => ({ findOne: repoFindOne })),
      transaction: transactionSpy,
    } as unknown as DataSource;

    getLoanEnabledMock = jest.fn(() => Promise.resolve({ enabled: loanEnabled }));
    const getEnableThirdPartyLoan = {
      execute: getLoanEnabledMock,
    } as unknown as GetEnableThirdPartyLoanAction;

    action = new ConvertOrderToLoanAction(dataSourceMock, getEnableThirdPartyLoan);
  });

  const dto: ProcessLoanDto = { client_operation_id: OP_ID };

  // ─── Happy path ────────────────────────────────────────────────────────

  it('convierte el pedido en LOAN, descuenta stock y registra el evento LOANED', async () => {
    const result = await action.execute(INVOICE_ID, dto, COMPANY_ID, OWNER);

    expect(result.success).toBe(true);
    expect(result.invoice_id).toBe(INVOICE_ID);
    expect(result.ticket_number).toBe('PED-100');
    expect(result.sale_number).toBeNull();

    // UPDATE: ticket_type=LOAN + sold_at + client_operation_id; sale_number NO se toca.
    expect(managerUpdate).toHaveBeenCalledTimes(1);
    const patch = managerUpdate.mock.calls[0][2] as Record<string, unknown>;
    expect(patch.ticket_type).toBe(TicketType.LOAN);
    expect(patch.sold_at).toBeInstanceOf(Date);
    expect(patch.client_operation_id).toBe(OP_ID);
    expect(patch).not.toHaveProperty('sale_number');

    // Inventario DEDUCT (como una venta) sin override.
    expect(adjustInventoryMock).toHaveBeenCalledTimes(1);
    const [, , invLines, direction, ctx] = adjustInventoryMock.mock.calls[0];
    expect(direction).toBe('DEDUCT');
    expect(invLines).toHaveLength(1);
    expect((ctx as { overrideStock?: boolean }).overrideStock).toBe(false);
    expect((ctx as { reason?: string }).reason).toBe('SALE');

    // Historial: evento LOANED sin monto (no hay dinero).
    expect(recordSaleStatusMock).toHaveBeenCalledTimes(1);
    const statusArgs = recordSaleStatusMock.mock.calls[0][1];
    expect(statusArgs.eventType).toBe(SaleStatusEventType.LOANED);
    expect(statusArgs.amount).toBeNull();
  });

  // ─── Gates 403 ───────────────────────────────────────────────────────────

  it('403 LOAN_NOT_OWNER si el actor no es el dueño (ni siquiera admin)', async () => {
    const employee: ProcessLoanActor = { id: 9, fullName: 'Cajero', type: 'employee' };
    await expect(action.execute(INVOICE_ID, dto, COMPANY_ID, employee)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    // Fail-fast: no consulta el setting ni abre transacción.
    expect(getLoanEnabledMock).not.toHaveBeenCalled();
    expect(transactionSpy).not.toHaveBeenCalled();
    expect(adjustInventoryMock).not.toHaveBeenCalled();
  });

  it('403 LOAN_NOT_OWNER expone el código en el payload', async () => {
    const manager: ProcessLoanActor = { id: 3, fullName: 'Manager', type: 'manager' };
    await expect(
      action.execute(INVOICE_ID, dto, COMPANY_ID, manager),
    ).rejects.toMatchObject({ response: { payload: { code: 'LOAN_NOT_OWNER' } } });
  });

  it('403 LOAN_DISABLED (fail-closed) si el setting está apagado en la BD', async () => {
    loanEnabled = false;
    await expect(action.execute(INVOICE_ID, dto, COMPANY_ID, OWNER)).rejects.toMatchObject({
      response: { payload: { code: 'LOAN_DISABLED' } },
    });
    // No abre transacción ni descuenta stock.
    expect(transactionSpy).not.toHaveBeenCalled();
    expect(adjustInventoryMock).not.toHaveBeenCalled();
  });

  // ─── Reglas de negocio (422) ──────────────────────────────────────────────

  it('INVOICE_NOT_FOUND si la factura no existe / no es de la company', async () => {
    saleInTx = null;
    const result = await action.execute(INVOICE_ID, dto, COMPANY_ID, OWNER);
    expect(result.success).toBe(false);
    expect(result.code).toBe('INVOICE_NOT_FOUND');
    expect(adjustInventoryMock).not.toHaveBeenCalled();
  });

  it('INVOICE_NOT_ORDER si la factura ya es una venta (SALE)', async () => {
    saleInTx = baseOrder({ ticket_type: TicketType.SALE, sale_number: 'V-1' });
    const result = await action.execute(INVOICE_ID, dto, COMPANY_ID, OWNER);
    expect(result.success).toBe(false);
    expect(result.code).toBe('INVOICE_NOT_ORDER');
    expect(managerUpdate).not.toHaveBeenCalled();
    expect(adjustInventoryMock).not.toHaveBeenCalled();
  });

  it('LOAN_REQUIRES_CUSTOMER si el pedido no tiene cliente asignado', async () => {
    saleInTx = baseOrder({ customer_id: null });
    const result = await action.execute(INVOICE_ID, dto, COMPANY_ID, OWNER);
    expect(result.success).toBe(false);
    expect(result.code).toBe('LOAN_REQUIRES_CUSTOMER');
    expect(managerUpdate).not.toHaveBeenCalled();
    expect(adjustInventoryMock).not.toHaveBeenCalled();
  });

  // ─── Stock ────────────────────────────────────────────────────────────────

  it('override_stock del owner se propaga a adjustInventory', async () => {
    await action.execute(INVOICE_ID, { client_operation_id: OP_ID, override_stock: true }, COMPANY_ID, OWNER);
    const ctx = adjustInventoryMock.mock.calls[0][4] as { overrideStock?: boolean };
    expect(ctx.overrideStock).toBe(true);
  });

  it('propaga INSUFFICIENT_STOCK (422) cuando el stock no alcanza y no hay override', async () => {
    adjustInventoryMock.mockRejectedValueOnce(new InsufficientStockError('Arroz', '1', '2'));
    await expect(action.execute(INVOICE_ID, dto, COMPANY_ID, OWNER)).rejects.toBeInstanceOf(
      InsufficientStockError,
    );
  });

  // ─── Idempotencia ───────────────────────────────────────────────────────

  it('fast-path idempotente: un LOAN previo con la misma llave NO reprocesa', async () => {
    existingLoan = { id: String(INVOICE_ID), ticket_number: 'PED-100' };
    const result = await action.execute(INVOICE_ID, dto, COMPANY_ID, OWNER);

    expect(result.success).toBe(true);
    expect(result.code).toBe('DUPLICATE_OPERATION');
    expect(result.replay).toBe(true);
    expect(result.invoice_id).toBe(INVOICE_ID);
    // NO abre transacción, NO descuenta stock de nuevo.
    expect(transactionSpy).not.toHaveBeenCalled();
    expect(adjustInventoryMock).not.toHaveBeenCalled();
  });

  it('carrera in-TX: si el pedido ya quedó LOAN con la misma llave, replay sin doble descuento', async () => {
    // El fast-path no lo vio (null), pero al lockear la fila ya es LOAN.
    existingLoan = null;
    saleInTx = baseOrder({ ticket_type: TicketType.LOAN, client_operation_id: OP_ID });
    const result = await action.execute(INVOICE_ID, dto, COMPANY_ID, OWNER);

    expect(result.success).toBe(true);
    expect(result.replay).toBe(true);
    expect(managerUpdate).not.toHaveBeenCalled();
    expect(adjustInventoryMock).not.toHaveBeenCalled();
  });

  it('unique_violation en el UPDATE se resuelve como replay del LOAN existente', async () => {
    // Otra request reclamó la llave: el UPDATE viola el índice único parcial.
    const dup = new QueryFailedError('update', [], new Error('dup')) as QueryFailedError & {
      code?: string;
    };
    dup.code = '23505';
    managerUpdate.mockRejectedValueOnce(dup);
    // La primera lectura fast-path devuelve null; tras la carrera, ya existe.
    repoFindOne
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: String(INVOICE_ID), ticket_number: 'PED-100' });

    const result = await action.execute(INVOICE_ID, dto, COMPANY_ID, OWNER);
    expect(result.success).toBe(true);
    expect(result.replay).toBe(true);
    expect(result.code).toBe('DUPLICATE_OPERATION');
  });

  // ─── Sin dinero ───────────────────────────────────────────────────────────

  it('no toca caja/crédito/puntos: solo UPDATE + inventario + historial', async () => {
    await action.execute(INVOICE_ID, dto, COMPANY_ID, OWNER);
    // El manager solo se usó para: findOne (lock), find (líneas) y update.
    // No hay save de SalePayment/SaleCredit ni movimientos (la action no los
    // importa). Verificamos que las únicas mutaciones son las esperadas.
    expect(managerUpdate).toHaveBeenCalledTimes(1);
    expect(adjustInventoryMock).toHaveBeenCalledTimes(1);
    expect(recordSaleStatusMock).toHaveBeenCalledTimes(1);
  });
});
