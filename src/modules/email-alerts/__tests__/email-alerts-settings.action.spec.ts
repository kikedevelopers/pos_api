import type { Repository } from 'typeorm';

import { GetEmailAlertsSettingsAction } from '../actions/get-email-alerts-settings.action';
import { SetEmailAlertEnabledAction } from '../actions/set-email-alert-enabled.action';
import { ALERT_TYPE_CREDIT_DUE_TODAY } from '../constants';
import type { AlertConfig } from '@/modules/alert-configs/entities/alert-config.entity';
import type { User } from '@/modules/users/entities/user.entity';

describe('GetEmailAlertsSettingsAction', () => {
  function build(rows: Array<{ type: string; enabled: boolean }>, owner: { email: string } | null) {
    const configsRepo = { find: jest.fn().mockResolvedValue(rows) } as unknown as Repository<AlertConfig>;
    const usersRepo = { findOne: jest.fn().mockResolvedValue(owner) } as unknown as Repository<User>;
    return new GetEmailAlertsSettingsAction(configsRepo, usersRepo);
  }

  it('devuelve el correo del owner y el estado de cada alerta', async () => {
    const action = build([{ type: ALERT_TYPE_CREDIT_DUE_TODAY, enabled: true }], { email: 'owner@x.com' });
    const result = await action.execute(8);
    expect(result.recipientEmail).toBe('owner@x.com');
    expect(result.alerts).toEqual([{ type: ALERT_TYPE_CREDIT_DUE_TODAY, enabled: true }]);
  });

  it('sin fila de config → la alerta está DESHABILITADA por defecto', async () => {
    const action = build([], { email: 'owner@x.com' });
    const result = await action.execute(8);
    expect(result.alerts).toEqual([{ type: ALERT_TYPE_CREDIT_DUE_TODAY, enabled: false }]);
  });

  it('recipientEmail null si no hay owner', async () => {
    const action = build([], null);
    expect((await action.execute(8)).recipientEmail).toBeNull();
  });
});

describe('SetEmailAlertEnabledAction', () => {
  it('actualiza la fila existente', async () => {
    const existing = { company_id: '8', type: ALERT_TYPE_CREDIT_DUE_TODAY, enabled: false };
    const save = jest.fn().mockResolvedValue(existing);
    const insert = jest.fn();
    const repo = {
      findOne: jest.fn().mockResolvedValue(existing),
      save,
      insert,
    } as unknown as Repository<AlertConfig>;

    const action = new SetEmailAlertEnabledAction(repo);
    const result = await action.execute(8, ALERT_TYPE_CREDIT_DUE_TODAY, true);

    expect(save).toHaveBeenCalledTimes(1);
    expect(insert).not.toHaveBeenCalled();
    expect(existing.enabled).toBe(true);
    expect(result).toEqual({ type: ALERT_TYPE_CREDIT_DUE_TODAY, enabled: true });
  });

  it('inserta si no existe', async () => {
    const insert = jest.fn().mockResolvedValue(undefined);
    const repo = {
      findOne: jest.fn().mockResolvedValue(null),
      save: jest.fn(),
      insert,
    } as unknown as Repository<AlertConfig>;

    const action = new SetEmailAlertEnabledAction(repo);
    const result = await action.execute(8, ALERT_TYPE_CREDIT_DUE_TODAY, true);

    expect(insert).toHaveBeenCalledTimes(1);
    expect(insert).toHaveBeenCalledWith(
      expect.objectContaining({ company_id: '8', type: ALERT_TYPE_CREDIT_DUE_TODAY, enabled: true }),
    );
    expect(result.enabled).toBe(true);
  });
});
