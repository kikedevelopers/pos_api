import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { DataSource } from 'typeorm';

import { RestaurantTable } from '@/modules/restaurant-tables/entities/restaurant-table.entity';
import { Salon } from '../entities/salon.entity';
import { AttachTableAction } from '../actions/attach-table.action';
import { DetachTableAction } from '../actions/detach-table.action';

type Row = Record<string, unknown> | null;

/**
 * El manager mock resuelve `findOne(Salon,...)` y `findOne(RestaurantTable,...)`
 * según la entidad pedida; `update` registra el patch aplicado.
 */
function buildManager(salon: Row, table: Row, tableAfter?: Row) {
  let tableReads = 0;
  const update = jest.fn().mockResolvedValue({ affected: 1 });
  const manager = {
    findOne: jest.fn((entity: unknown) => {
      if (entity === Salon) {
        return Promise.resolve(salon);
      }
      tableReads += 1;
      // La 2ª lectura de mesa devuelve el estado post-update (re-fetch final).
      return Promise.resolve(tableReads >= 2 && tableAfter !== undefined ? tableAfter : table);
    }),
    update,
  };
  return { manager, update };
}

async function makeAttach(manager: unknown) {
  const dataSourceMock = {
    transaction: jest.fn(async <T>(cb: (m: unknown) => Promise<T>) => cb(manager)),
  };
  const module: TestingModule = await Test.createTestingModule({
    providers: [AttachTableAction, { provide: DataSource, useValue: dataSourceMock }],
  }).compile();
  return module.get(AttachTableAction);
}

async function makeDetach(manager: unknown) {
  const dataSourceMock = {
    transaction: jest.fn(async <T>(cb: (m: unknown) => Promise<T>) => cb(manager)),
  };
  const module: TestingModule = await Test.createTestingModule({
    providers: [DetachTableAction, { provide: DataSource, useValue: dataSourceMock }],
  }).compile();
  return module.get(DetachTableAction);
}

const ACTIVE_SALON = { id: '5', company_id: '42', is_archived: false };

describe('AttachTableAction', () => {
  it('ancla una mesa suelta: salon_id=salón, owned_by_salon=false', async () => {
    const { manager, update } = buildManager(
      ACTIVE_SALON,
      { id: '9', company_id: '42', salon_id: null, is_archived: false },
      { id: '9', company_id: '42', salon_id: '5', owned_by_salon: false },
    );
    const action = await makeAttach(manager);

    await action.execute(5, 9, 42);

    expect(update).toHaveBeenCalledWith(
      RestaurantTable,
      { id: '9', company_id: '42' },
      { salon_id: '5', owned_by_salon: false },
    );
  });

  it('404 si el salón no existe', async () => {
    const { manager } = buildManager(null, {
      id: '9',
      company_id: '42',
      salon_id: null,
      is_archived: false,
    });
    const action = await makeAttach(manager);
    await expect(action.execute(5, 9, 42)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('400 si el salón está archivado', async () => {
    const { manager } = buildManager(
      { ...ACTIVE_SALON, is_archived: true },
      { id: '9', salon_id: null },
    );
    const action = await makeAttach(manager);
    await expect(action.execute(5, 9, 42)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('400 si la mesa está archivada', async () => {
    const { manager } = buildManager(ACTIVE_SALON, {
      id: '9',
      company_id: '42',
      salon_id: null,
      is_archived: true,
    });
    const action = await makeAttach(manager);
    await expect(action.execute(5, 9, 42)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('400 si la mesa ya está en ESTE salón', async () => {
    const { manager } = buildManager(ACTIVE_SALON, {
      id: '9',
      company_id: '42',
      salon_id: '5',
      is_archived: false,
    });
    const action = await makeAttach(manager);
    await expect(action.execute(5, 9, 42)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('409 si la mesa ya está en OTRO salón', async () => {
    const { manager } = buildManager(ACTIVE_SALON, {
      id: '9',
      company_id: '42',
      salon_id: '8',
      is_archived: false,
    });
    const action = await makeAttach(manager);
    await expect(action.execute(5, 9, 42)).rejects.toBeInstanceOf(ConflictException);
  });
});

describe('DetachTableAction', () => {
  it('desancla una mesa anclada (owned=false): salon_id=null', async () => {
    const { manager, update } = buildManager(
      ACTIVE_SALON,
      { id: '9', company_id: '42', salon_id: '5', owned_by_salon: false },
      { id: '9', company_id: '42', salon_id: null },
    );
    const action = await makeDetach(manager);

    await action.execute(5, 9, 42);

    expect(update).toHaveBeenCalledWith(
      RestaurantTable,
      { id: '9', company_id: '42' },
      { salon_id: null },
    );
  });

  it('400 si la mesa fue CREADA dentro del salón (owned=true, permanente)', async () => {
    const { manager } = buildManager(ACTIVE_SALON, {
      id: '9',
      company_id: '42',
      salon_id: '5',
      owned_by_salon: true,
    });
    const action = await makeDetach(manager);
    await expect(action.execute(5, 9, 42)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('400 si la mesa no está anclada a este salón', async () => {
    const { manager } = buildManager(ACTIVE_SALON, {
      id: '9',
      company_id: '42',
      salon_id: '8',
      owned_by_salon: false,
    });
    const action = await makeDetach(manager);
    await expect(action.execute(5, 9, 42)).rejects.toBeInstanceOf(BadRequestException);
  });
});
