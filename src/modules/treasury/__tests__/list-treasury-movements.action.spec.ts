import type { DataSource } from 'typeorm';

import { ListTreasuryMovementsAction } from '../actions/list-treasury-movements.action';

/**
 * Tests unitarios de `ListTreasuryMovementsAction`. Foco: enriquecimiento con
 * nombres de cuenta, no exposición de `company_id`, aislamiento multi-tenant y
 * aplicación del filtro de rango.
 */
describe('ListTreasuryMovementsAction', () => {
  const bankRows = [{ id: 1, name: 'Bancolombia' }];
  const walletRows = [{ id: 10, name: 'Nequi' }];
  const registerRows = [{ id: 100, name: 'Juan Pérez' }];

  const movements = [
    {
      id: '2',
      amount: '5000.00',
      movement_type: 'INCOME',
      concept: 'SALE_PAYMENT',
      description: 'Venta de contado',
      source_type: null,
      source_id: null,
      destination_type: 'cash_register',
      destination_id: '100',
      reference_code: null,
      created_by: 'Kike',
      created_by_id: '1',
      created_at: new Date('2026-07-23T15:00:00.000Z'),
      company_id: '13',
    },
    {
      id: '1',
      amount: '20000.00',
      movement_type: 'TRANSFER',
      concept: 'TRANSFER',
      description: 'Traslado a Nequi',
      source_type: 'bank',
      source_id: '1',
      destination_type: 'wallet',
      destination_id: '10',
      reference_code: null,
      created_by: 'Kike',
      created_by_id: '1',
      created_at: new Date('2026-07-23T14:00:00.000Z'),
      company_id: '13',
    },
  ];

  const buildAction = () => {
    const qb = {
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      getMany: jest.fn().mockResolvedValue(movements),
    };
    const query = jest.fn((sql: string, _params?: unknown[]) => {
      if (sql.includes('FROM banks')) return Promise.resolve(bankRows);
      if (sql.includes('FROM wallets')) return Promise.resolve(walletRows);
      if (sql.includes('cash_registers')) return Promise.resolve(registerRows);
      return Promise.resolve([]);
    });
    const dataSource = {
      getRepository: jest.fn(() => ({ createQueryBuilder: jest.fn(() => qb) })),
      query,
    } as unknown as DataSource;
    return { action: new ListTreasuryMovementsAction(dataSource), qb, query };
  };

  it('enriquece cada movimiento con los nombres de cuenta resueltos', async () => {
    const { action } = buildAction();
    const result = await action.execute(13);

    expect(result).toHaveLength(2);
    // INGRESO → solo destino.
    expect(result[0].destination_name).toBe('Juan Pérez');
    expect(result[0].source_name).toBeNull();
    // TRASLADO → origen y destino.
    expect(result[1].source_name).toBe('Bancolombia');
    expect(result[1].destination_name).toBe('Nequi');
  });

  it('normaliza amount a number y created_at a ISO, sin exponer company_id', async () => {
    const { action } = buildAction();
    const result = await action.execute(13);

    expect(result[0].amount).toBe(5000);
    expect(result[0].id).toBe(2);
    expect(result[0].created_at).toBe('2026-07-23T15:00:00.000Z');
    expect('company_id' in result[0]).toBe(false);
  });

  it('preserva el orden recibido (más reciente primero)', async () => {
    const { action } = buildAction();
    const result = await action.execute(13);
    expect(result.map((m) => m.id)).toEqual([2, 1]);
  });

  it('filtra por company_id y scopea las queries de nombres a la company', async () => {
    const { action, qb, query } = buildAction();
    await action.execute(13);

    expect(qb.where).toHaveBeenCalledWith('m.company_id = :companyId', { companyId: '13' });
    // Las 3 queries de nombres reciben el company_id como parámetro.
    for (const call of query.mock.calls) {
      expect(call[1]).toEqual(['13']);
    }
  });

  it('aplica el filtro de rango cuando se pasan from/to', async () => {
    const { action, qb } = buildAction();
    await action.execute(13, '2026-07-23T05:00:00.000Z', '2026-07-24T04:59:59.999Z');

    expect(qb.andWhere).toHaveBeenCalledWith('m.created_at >= :from', {
      from: new Date('2026-07-23T05:00:00.000Z'),
    });
    expect(qb.andWhere).toHaveBeenCalledWith('m.created_at <= :to', {
      to: new Date('2026-07-24T04:59:59.999Z'),
    });
  });

  it('sin from/to no aplica filtro de rango', async () => {
    const { action, qb } = buildAction();
    await action.execute(13);
    expect(qb.andWhere).not.toHaveBeenCalled();
  });
});
