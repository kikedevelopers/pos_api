import { NotFoundException } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import { RestaurantTable } from '@/modules/restaurant-tables/entities/restaurant-table.entity';
import { FindSalonAction } from '../actions/find-salon.action';
import { Salon } from '../entities/salon.entity';

describe('FindSalonAction', () => {
  const build = async (salon: Partial<Salon> | null, tables: Partial<RestaurantTable>[] = []) => {
    const salonRepo = { manager: { findOne: jest.fn().mockResolvedValue(salon) } };
    const tableRepo = { find: jest.fn().mockResolvedValue(tables) };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        FindSalonAction,
        { provide: getRepositoryToken(Salon), useValue: salonRepo },
        { provide: getRepositoryToken(RestaurantTable), useValue: tableRepo },
      ],
    }).compile();
    return { action: module.get(FindSalonAction), tableRepo };
  };

  it('devuelve el salón activo con sus mesas activas', async () => {
    const { action, tableRepo } = await build({ id: '5', company_id: '42', is_archived: false }, [
      { id: '9' },
    ]);
    const result = await action.execute(5, 42);
    expect(result.salon.id).toBe('5');
    expect(result.tables).toHaveLength(1);
    // Solo mesas activas de ESTE salón y company.
    expect(tableRepo.find).toHaveBeenCalledWith({
      where: { company_id: '42', salon_id: '5', is_archived: false },
      order: { name: 'ASC' },
    });
  });

  it('404 si el salón no existe', async () => {
    const { action } = await build(null);
    await expect(action.execute(5, 42)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('404 si el salón está archivado', async () => {
    const { action } = await build({ id: '5', company_id: '42', is_archived: true });
    await expect(action.execute(5, 42)).rejects.toBeInstanceOf(NotFoundException);
  });
});
