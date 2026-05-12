import { InternalServerErrorException } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';

import { IncrementTicketNumberAction } from '../actions/increment-ticket-number.action';
import { TicketSettingType } from '../entities/ticket-setting.entity';

/**
 * Tests del incremento atómico:
 *   - Devuelve `{ number, formatted }` con number = current_number post-update.
 *   - Aplica `formatTicketNumber(prefix, suffix, number)`.
 *   - Lanza InternalServerError si la row no existe (seed faltante).
 */
describe('IncrementTicketNumberAction', () => {
  let action: IncrementTicketNumberAction;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [IncrementTicketNumberAction],
    }).compile();
    action = module.get(IncrementTicketNumberAction);
  });

  function buildManagerMock(returningRaw: unknown): {
    createQueryBuilder: jest.Mock;
  } {
    // QueryBuilder fluent chain: update -> set -> where -> returning -> execute.
    const qb: Record<string, unknown> = {};
    qb.update = jest.fn().mockReturnValue(qb);
    qb.set = jest.fn().mockReturnValue(qb);
    qb.where = jest.fn().mockReturnValue(qb);
    qb.returning = jest.fn().mockReturnValue(qb);
    qb.execute = jest.fn().mockResolvedValue({ raw: returningRaw });
    return {
      createQueryBuilder: jest.fn().mockReturnValue(qb),
    };
  }

  it('incrementa y formatea con prefix (F-008)', async () => {
    const manager = buildManagerMock([{ current_number: 8, prefix: 'F', suffix: null }]);

    const result = await action.execute(manager as never, 42, TicketSettingType.SALE);

    expect(result).toEqual({ number: 8, formatted: 'F-008' });
  });

  it('incrementa sin prefix ni suffix (solo padded number)', async () => {
    const manager = buildManagerMock([{ current_number: 1, prefix: null, suffix: null }]);

    const result = await action.execute(manager as never, 1, TicketSettingType.ORDER);

    expect(result).toEqual({ number: 1, formatted: '001' });
  });

  it('lanza InternalServerError si la row no existe (seed faltante)', async () => {
    const manager = buildManagerMock([]);

    await expect(
      action.execute(manager as never, 99, TicketSettingType.PURCHASE),
    ).rejects.toBeInstanceOf(InternalServerErrorException);
  });
});
