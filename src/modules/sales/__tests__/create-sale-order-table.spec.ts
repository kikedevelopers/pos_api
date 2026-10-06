import { type DataSource } from 'typeorm';

// --------------------------------------------------------------------------
// Tests de INTEGRACIÓN de `CreateSaleAction` enfocados en la MESA (modo
// restaurante, botón "Enviar a"): que crear un pedido con `table_id` ocupe la
// mesa vía `resolveAndOccupyOrderTable` y PERSISTA el snapshot que ese helper
// devuelve (table_id/salon_id/table_name/salon_name) en la factura; y que sin
// `table_id` no se toque ninguna mesa y los campos queden en null.
//
// La LÓGICA de validación/lock/ocupación vive y se prueba en
// `resolve-order-table.helper.spec`; aquí mockeamos ese helper para observar la
// INTEGRACIÓN (que el action lo invoca con los args correctos y usa su
// resultado). Los demás helpers pesados (productos, empaques, recetas,
// historial, lookups) se mockean a no-ops para aislar el flujo de la mesa.
// --------------------------------------------------------------------------
jest.mock('../internal/resolve-order-table.helper', () => ({
  resolveAndOccupyOrderTable: jest.fn(),
  freeOrderTable: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('@/modules/products/internal/accessible-products.helper', () => ({
  resolveAccessibleProducts: jest.fn(),
}));
jest.mock('../internal/sellable-products.guard', () => ({
  assertSellableProducts: jest.fn(),
}));
jest.mock('@/modules/products/internal/resolve-packaging-value.helper', () => ({
  resolvePackagingValues: jest.fn().mockResolvedValue(new Map()),
}));
jest.mock('@/modules/products/internal/resolve-combo-recipe.helper', () => ({
  resolveComboRecipes: jest.fn().mockResolvedValue(new Map()),
}));
jest.mock('../internal/record-sale-status.helper', () => ({
  recordSaleStatus: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../internal/sale-lookups', () => ({
  findSaleLines: jest.fn().mockResolvedValue([]),
  findSalePayments: jest.fn().mockResolvedValue([]),
  findSaleCredit: jest.fn().mockResolvedValue(null),
}));

import { resolveAccessibleProducts } from '@/modules/products/internal/accessible-products.helper';
import type { IncrementTicketNumberAction } from '@/modules/ticket-settings/actions/increment-ticket-number.action';
import type { FinancialMovementsService } from '@/modules/financial-movements/financial-movements.service';

import { CreateSaleAction, type SaleCreator } from '../actions/create-sale.action';
import { TicketType } from '../entities/sale-invoice.entity';
import {
  resolveAndOccupyOrderTable,
  type OrderTableResult,
} from '../internal/resolve-order-table.helper';
import type { CreateSaleDto } from '../dto/create-sale.dto';

const resolveTableMock = resolveAndOccupyOrderTable as jest.MockedFunction<
  typeof resolveAndOccupyOrderTable
>;
const accessibleMock = resolveAccessibleProducts as jest.MockedFunction<
  typeof resolveAccessibleProducts
>;

const COMPANY_ID = 42;
const CREATOR: SaleCreator = { id: 7, fullName: 'Kike Pacheco' };

describe('CreateSaleAction · ocupación de mesa (modo restaurante)', () => {
  let action: CreateSaleAction;
  let createdSale: Record<string, unknown> | null;
  let managerMock: Record<string, jest.Mock>;

  function baseDto(over: Partial<CreateSaleDto> = {}): CreateSaleDto {
    return {
      customer_name: null,
      items: [{ item_id: 11, quantity: 1, price: 100, total: 100 } as never],
      total: 100,
      cost: 60,
      profit: 40,
      margin: 40,
      client_operation_id: null,
      ...over,
    } as CreateSaleDto;
  }

  beforeEach(() => {
    jest.clearAllMocks();
    createdSale = null;

    // El mapa de accesibles iguala a los ids pedidos (pasa el gate: size === ids.length).
    accessibleMock.mockImplementation((_m, _c, ids: number[]) =>
      Promise.resolve(new Map(ids.map((id) => [id, { id: String(id) } as never]))),
    );

    managerMock = {
      // Customer (no se usa: sin cliente) y SaleInvoice (loadAggregate).
      findOne: jest.fn((entity: { name?: string } | string) => {
        const name = typeof entity === 'string' ? entity : (entity.name ?? 'Unknown');
        if (name === 'SaleInvoice') {
          return Promise.resolve(createdSale);
        }
        return Promise.resolve(null);
      }),
      find: jest.fn(() => Promise.resolve([{ id: '11', packaging_id: null }])),
      create: jest.fn((_entity: unknown, input: Record<string, unknown>) => {
        createdSale = { ...input, id: '500' };
        return input;
      }),
      save: jest.fn(() => Promise.resolve(createdSale)),
      insert: jest.fn().mockResolvedValue({ raw: [], identifiers: [], generatedMaps: [] }),
    };

    const dataSourceMock = {
      transaction: jest.fn((cb: (m: unknown) => unknown) => cb(managerMock)),
      getRepository: jest.fn(() => ({ findOne: jest.fn().mockResolvedValue(null) })),
    } as unknown as DataSource;

    const incrementMock = {
      execute: jest.fn().mockResolvedValue({ formatted: 'PED-1' }),
    } as unknown as IncrementTicketNumberAction;

    const financialMock = { record: jest.fn() } as unknown as FinancialMovementsService;

    action = new CreateSaleAction(dataSourceMock, incrementMock, financialMock);
  });

  it('con table_id → ocupa la mesa y persiste su snapshot en la factura', async () => {
    const tableResult: OrderTableResult = {
      tableId: '77',
      salonId: '3',
      tableName: 'Mesa 5',
      salonName: 'Sur A',
    };
    resolveTableMock.mockResolvedValue(tableResult);

    await action.execute(baseDto({ table_id: 77, salon_id: 3 }), COMPANY_ID, CREATOR);

    // Se invocó el helper con (manager, companyId, tableId, salonId).
    expect(resolveTableMock).toHaveBeenCalledTimes(1);
    expect(resolveTableMock).toHaveBeenCalledWith(managerMock, COMPANY_ID, 77, 3);

    // La factura persiste el snapshot DEVUELTO por el helper (no el crudo del dto).
    expect(createdSale).toMatchObject({
      ticket_type: TicketType.ORDER,
      table_id: '77',
      salon_id: '3',
      table_name: 'Mesa 5',
      salon_name: 'Sur A',
    });
  });

  it('mesa suelta (sin salon_id) → salon_id null en el helper y snapshot sin salón', async () => {
    resolveTableMock.mockResolvedValue({
      tableId: '88',
      salonId: null,
      tableName: 'Barra 1',
      salonName: null,
    });

    await action.execute(baseDto({ table_id: 88 }), COMPANY_ID, CREATOR);

    expect(resolveTableMock).toHaveBeenCalledWith(managerMock, COMPANY_ID, 88, null);
    expect(createdSale).toMatchObject({
      table_id: '88',
      salon_id: null,
      table_name: 'Barra 1',
      salon_name: null,
    });
  });

  it('sin table_id (retail / registro directo) → NO ocupa mesa y los campos quedan null', async () => {
    await action.execute(baseDto(), COMPANY_ID, CREATOR);

    expect(resolveTableMock).not.toHaveBeenCalled();
    expect(createdSale).toMatchObject({
      table_id: null,
      salon_id: null,
      table_name: null,
      salon_name: null,
    });
  });

  it('table_id = 0 (valor no válido) se trata como sin mesa', async () => {
    await action.execute(baseDto({ table_id: 0 }), COMPANY_ID, CREATOR);

    expect(resolveTableMock).not.toHaveBeenCalled();
    expect(createdSale).toMatchObject({ table_id: null });
  });

  it('propaga el error del helper (p. ej. 409 TABLE_OCCUPIED) sin crear la factura', async () => {
    resolveTableMock.mockRejectedValue(
      Object.assign(new Error('ocupada'), { response: { payload: { code: 'TABLE_OCCUPIED' } } }),
    );

    await expect(
      action.execute(baseDto({ table_id: 77 }), COMPANY_ID, CREATOR),
    ).rejects.toMatchObject({ response: { payload: { code: 'TABLE_OCCUPIED' } } });

    // La mesa se resuelve ANTES de crear la factura → no se persistió nada.
    expect(managerMock.create).not.toHaveBeenCalled();
    expect(managerMock.save).not.toHaveBeenCalled();
  });
});
