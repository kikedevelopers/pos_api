import { Test, type TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import { RestaurantTable } from '@/modules/restaurant-tables/entities/restaurant-table.entity';
import { FindAllSalonsAction } from '../actions/find-all-salons.action';
import { Salon } from '../entities/salon.entity';

describe('FindAllSalonsAction', () => {
  it('lista salones activos con el conteo de sus mesas activas', async () => {
    const salonRepo = {
      find: jest.fn().mockResolvedValue([
        { id: '5', name: 'Sur A' },
        { id: '6', name: 'Sur B' },
      ]),
    };
    const qb = {
      select: jest.fn().mockReturnThis(),
      addSelect: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      groupBy: jest.fn().mockReturnThis(),
      getRawMany: jest.fn().mockResolvedValue([{ salon_id: '5', count: '3' }]),
    };
    const tableRepo = { createQueryBuilder: jest.fn().mockReturnValue(qb) };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        FindAllSalonsAction,
        { provide: getRepositoryToken(Salon), useValue: salonRepo },
        { provide: getRepositoryToken(RestaurantTable), useValue: tableRepo },
      ],
    }).compile();
    const action = module.get(FindAllSalonsAction);

    const result = await action.execute(42);

    expect(salonRepo.find).toHaveBeenCalledWith({
      where: { company_id: '42', is_archived: false },
      order: { name: 'ASC' },
    });
    // Salón con mesas → su conteo; salón sin filas → 0.
    expect(result).toEqual([
      { salon: { id: '5', name: 'Sur A' }, tableCount: 3 },
      { salon: { id: '6', name: 'Sur B' }, tableCount: 0 },
    ]);
    // El conteo filtra company + activas + ancladas.
    expect(qb.andWhere).toHaveBeenCalledWith('t.is_archived = false');
    expect(qb.andWhere).toHaveBeenCalledWith('t.salon_id IS NOT NULL');
  });
});
