import { TaxesService } from '../taxes.service';

describe('TaxesService', () => {
  it('lista solo tarifas activas, ordenadas por sort_order e id', async () => {
    const find = jest.fn().mockResolvedValue([]);
    const service = new TaxesService({ find } as never);

    await service.findAllActive();

    expect(find).toHaveBeenCalledWith({
      where: { is_active: true },
      order: { sort_order: 'ASC', id: 'ASC' },
    });
  });

  it('devuelve las filas del repositorio', async () => {
    const rows = [{ id: '1', code: 'IVA_19' }];
    const service = new TaxesService({ find: jest.fn().mockResolvedValue(rows) } as never);

    await expect(service.findAllActive()).resolves.toBe(rows);
  });
});
