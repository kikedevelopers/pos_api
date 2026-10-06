import { ConflictException, UnprocessableEntityException } from '@nestjs/common';

import { Company } from '@/modules/companies/entities/company.entity';
import { RestaurantTable } from '@/modules/restaurant-tables/entities/restaurant-table.entity';
import { Salon } from '@/modules/salons/entities/salon.entity';

import { freeOrderTable, resolveAndOccupyOrderTable } from '../resolve-order-table.helper';

type Row = Record<string, unknown> | null;

/**
 * El manager mock resuelve findOne según la entidad y registra el update de la
 * mesa (ocupar). Es la defensa REAL contra ocupar una mesa ya ocupada.
 */
function buildManager(opts: { company?: Row; table?: Row; salon?: Row }) {
  const update = jest.fn().mockResolvedValue({ affected: 1 });
  const manager = {
    findOne: jest.fn((entity: unknown): Promise<Row> => {
      if (entity === Company) {
        return Promise.resolve(opts.company ?? { id: '42', pos_mode: 'restaurant' });
      }
      if (entity === RestaurantTable) {
        return Promise.resolve(opts.table ?? null);
      }
      if (entity === Salon) {
        return Promise.resolve(opts.salon ?? null);
      }
      return Promise.resolve(null);
    }),
    update,
  };
  return { manager, update };
}

const FREE_TABLE = {
  id: '9',
  company_id: '42',
  name: 'Mesa 1',
  salon_id: null,
  status: 'free',
  is_archived: false,
};

describe('resolveAndOccupyOrderTable', () => {
  it('ocupa una mesa suelta libre y devuelve su snapshot', async () => {
    const { manager, update } = buildManager({ table: { ...FREE_TABLE } });

    const result = await resolveAndOccupyOrderTable(manager as never, 42, 9, null);

    expect(result).toEqual({ tableId: '9', salonId: null, tableName: 'Mesa 1', salonName: null });
    expect(update).toHaveBeenCalledWith(
      RestaurantTable,
      { id: '9', company_id: '42' },
      { status: 'occupied' },
    );
  });

  it('422 si la company no está en modo restaurante', async () => {
    const { manager } = buildManager({
      company: { id: '42', pos_mode: 'retail' },
      table: { ...FREE_TABLE },
    });
    await expect(resolveAndOccupyOrderTable(manager as never, 42, 9, null)).rejects.toBeInstanceOf(
      UnprocessableEntityException,
    );
  });

  it('422 si la mesa no existe / otra company / archivada', async () => {
    const { manager } = buildManager({ table: null });
    await expect(resolveAndOccupyOrderTable(manager as never, 42, 9, null)).rejects.toBeInstanceOf(
      UnprocessableEntityException,
    );
  });

  it('409 si la mesa YA está ocupada (defensa contra doble envío)', async () => {
    const { manager, update } = buildManager({ table: { ...FREE_TABLE, status: 'occupied' } });
    await expect(resolveAndOccupyOrderTable(manager as never, 42, 9, null)).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(update).not.toHaveBeenCalled();
  });

  it('con salón: valida pertenencia y guarda ambos snapshots', async () => {
    const { manager, update } = buildManager({
      table: { ...FREE_TABLE, salon_id: '5' },
      salon: { id: '5', company_id: '42', name: 'Sur A', is_archived: false },
    });

    const result = await resolveAndOccupyOrderTable(manager as never, 42, 9, 5);

    expect(result).toEqual({ tableId: '9', salonId: '5', tableName: 'Mesa 1', salonName: 'Sur A' });
    expect(update).toHaveBeenCalled();
  });

  it('422 si la mesa NO pertenece al salón indicado', async () => {
    const { manager, update } = buildManager({ table: { ...FREE_TABLE, salon_id: '8' } });
    await expect(resolveAndOccupyOrderTable(manager as never, 42, 9, 5)).rejects.toBeInstanceOf(
      UnprocessableEntityException,
    );
    expect(update).not.toHaveBeenCalled();
  });

  it('422 si el salón indicado no existe', async () => {
    const { manager } = buildManager({ table: { ...FREE_TABLE, salon_id: '5' }, salon: null });
    await expect(resolveAndOccupyOrderTable(manager as never, 42, 9, 5)).rejects.toBeInstanceOf(
      UnprocessableEntityException,
    );
  });
});

describe('freeOrderTable', () => {
  it('libera la mesa (status=free)', async () => {
    const update = jest.fn().mockResolvedValue({ affected: 1 });
    await freeOrderTable({ update } as never, 42, '9');
    expect(update).toHaveBeenCalledWith(
      RestaurantTable,
      { id: '9', company_id: '42' },
      { status: 'free' },
    );
  });

  it('no hace nada si el pedido no tenía mesa (null)', async () => {
    const update = jest.fn();
    await freeOrderTable({ update } as never, 42, null);
    expect(update).not.toHaveBeenCalled();
  });
});
