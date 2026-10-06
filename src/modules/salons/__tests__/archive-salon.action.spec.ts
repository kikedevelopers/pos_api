import { NotFoundException } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { DataSource } from 'typeorm';

import { ArchiveSalonAction } from '../actions/archive-salon.action';
import { RestaurantTable } from '@/modules/restaurant-tables/entities/restaurant-table.entity';
import { Salon } from '../entities/salon.entity';

interface UpdateCall {
  entity: unknown;
  criteria: Record<string, unknown>;
  patch: Record<string, unknown>;
}

describe('ArchiveSalonAction', () => {
  let action: ArchiveSalonAction;
  let updates: UpdateCall[];

  const build = async (salon: Partial<Salon> | null) => {
    updates = [];
    const managerMock = {
      findOne: jest.fn().mockResolvedValue(salon),
      update: jest.fn(
        (entity: unknown, criteria: Record<string, unknown>, patch: Record<string, unknown>) => {
          updates.push({ entity, criteria, patch });
          return Promise.resolve({ affected: 1 });
        },
      ),
    };
    const dataSourceMock = {
      transaction: jest.fn(async <T>(cb: (m: typeof managerMock) => Promise<T>) => cb(managerMock)),
    };
    const module: TestingModule = await Test.createTestingModule({
      providers: [ArchiveSalonAction, { provide: DataSource, useValue: dataSourceMock }],
    }).compile();
    action = module.get(ArchiveSalonAction);
  };

  it('404 si el salón no existe', async () => {
    await build(null);
    await expect(action.execute(5, 42)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('404 si ya está archivado', async () => {
    await build({ id: '5', company_id: '42', is_archived: true });
    await expect(action.execute(5, 42)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('archiva las mesas propias, desancla las ancladas y archiva el salón', async () => {
    await build({ id: '5', company_id: '42', is_archived: false });

    const result = await action.execute(5, 42);

    expect(result).toEqual({ archived: true });

    const tableUpdates = updates.filter((u) => u.entity === RestaurantTable);
    // Mesas propias (owned_by_salon=true) → is_archived=true.
    const ownedArchive = tableUpdates.find((u) => u.criteria.owned_by_salon === true);
    expect(ownedArchive?.criteria).toMatchObject({
      salon_id: '5',
      owned_by_salon: true,
      is_archived: false,
    });
    expect(ownedArchive?.patch).toEqual({ is_archived: true });
    // Mesas ancladas (owned_by_salon=false) → salon_id=null (se desanclan).
    const attachedDetach = tableUpdates.find((u) => u.criteria.owned_by_salon === false);
    expect(attachedDetach?.criteria).toMatchObject({
      salon_id: '5',
      owned_by_salon: false,
      is_archived: false,
    });
    expect(attachedDetach?.patch).toEqual({ salon_id: null });
    // El salón queda archivado.
    const salonUpdate = updates.find((u) => u.entity === Salon);
    expect(salonUpdate?.patch).toEqual({ is_archived: true });
  });

  it('las mesas ancladas NO se archivan (solo se desanclan)', async () => {
    await build({ id: '5', company_id: '42', is_archived: false });
    await action.execute(5, 42);

    const attachedDetach = updates.find(
      (u) => u.entity === RestaurantTable && u.criteria.owned_by_salon === false,
    );
    expect(attachedDetach?.patch).not.toHaveProperty('is_archived');
  });
});
