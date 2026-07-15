import { Test, type TestingModule } from '@nestjs/testing';

import { CreateDefaultAppSettingsAction } from '../actions/create-default-app-settings.action';
import { APP_SETTING_KEYS, type AppSetting } from '../entities/app-setting.entity';

describe('CreateDefaultAppSettingsAction', () => {
  let action: CreateDefaultAppSettingsAction;
  let createdRows: Partial<AppSetting>[];
  let managerMock: { getRepository: jest.Mock };

  beforeEach(async () => {
    createdRows = [];

    const repoMock = {
      create: jest.fn((input: Partial<AppSetting>) => {
        createdRows.push(input);
        return input as AppSetting;
      }),
      save: jest.fn(
        (rows: AppSetting[]): Promise<AppSetting[]> =>
          Promise.resolve(rows.map((r, i) => ({ ...r, id: String(i + 1) }))),
      ),
    };
    managerMock = { getRepository: jest.fn().mockReturnValue(repoMock) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [CreateDefaultAppSettingsAction],
    }).compile();

    action = module.get(CreateDefaultAppSettingsAction);
  });

  it('crea los settings defaults (app_color_mode=white, pos_margins_enabled=false, include_orders_in_reports=false)', async () => {
    await action.execute(managerMock as never, {
      companyId: 42,
      createdBy: { id: 7, fullName: 'Kike Pacheco' },
    });

    expect(createdRows).toHaveLength(3);

    const map = new Map(createdRows.map((r) => [r.key, r.value]));
    expect(map.get(APP_SETTING_KEYS.APP_COLOR_MODE)).toBe('white');
    expect(map.get(APP_SETTING_KEYS.POS_MARGINS_ENABLED)).toBe('false');
    expect(map.get(APP_SETTING_KEYS.INCLUDE_ORDERS_IN_REPORTS)).toBe('false');

    for (const row of createdRows) {
      expect(row.company_id).toBe('42');
    }
  });
});
