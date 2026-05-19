import { Test, type TestingModule } from '@nestjs/testing';

import { CreateDefaultTicketSettingsAction } from '../actions/create-default-ticket-settings.action';
import { TicketSettingType, type TicketSetting } from '../entities/ticket-setting.entity';

/**
 * Tests unitarios de `CreateDefaultTicketSettingsAction`. Cubrimos:
 *   - Crea exactamente 5 filas (una por TicketSettingType).
 *   - Cada fila tiene `current_number = 0` y `company_id` del input.
 *   - El action NO abre transacción propia — usa el `manager` que recibe.
 */
describe('CreateDefaultTicketSettingsAction', () => {
  let action: CreateDefaultTicketSettingsAction;
  let createdRows: Partial<TicketSetting>[];
  let managerMock: { getRepository: jest.Mock };

  beforeEach(async () => {
    createdRows = [];

    const repoMock = {
      create: jest.fn((input: Partial<TicketSetting>) => {
        createdRows.push(input);
        return input as TicketSetting;
      }),
      save: jest.fn(
        (rows: TicketSetting[]): Promise<TicketSetting[]> =>
          Promise.resolve(rows.map((r, i) => ({ ...r, id: String(i + 1) }))),
      ),
    };
    managerMock = { getRepository: jest.fn().mockReturnValue(repoMock) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [CreateDefaultTicketSettingsAction],
    }).compile();

    action = module.get(CreateDefaultTicketSettingsAction);
  });

  it('crea las 5 filas iniciales de TicketSettingType con current_number=0', async () => {
    await action.execute(managerMock as never, {
      companyId: 42,
      createdBy: { id: 7, fullName: 'Kike Pacheco' },
    });

    expect(createdRows).toHaveLength(5);

    const types = createdRows.map((r) => r.ticket_type);
    expect(types).toEqual(
      expect.arrayContaining([
        TicketSettingType.ORDER,
        TicketSettingType.SALE,
        TicketSettingType.CREDIT_NOTE,
        TicketSettingType.DEBIT_NOTE,
        TicketSettingType.PURCHASE,
      ]),
    );

    const EXPECTED_PREFIXES: Record<string, string> = {
      [TicketSettingType.ORDER]: 'PED',
      [TicketSettingType.SALE]: 'VTA',
      [TicketSettingType.CREDIT_NOTE]: 'NC',
      [TicketSettingType.DEBIT_NOTE]: 'ND',
      [TicketSettingType.PURCHASE]: 'COMP',
    };

    for (const row of createdRows) {
      expect(row.company_id).toBe('42');
      expect(row.current_number).toBe(0);
      expect(row.suffix).toBeNull();
      expect(row.prefix).toBe(EXPECTED_PREFIXES[row.ticket_type as string]);
    }
  });
});
