import type { ConfigService } from '@nestjs/config';
import type { Repository } from 'typeorm';

jest.mock('@/modules/mail/templates/render', () => ({
  renderEmail: jest.fn().mockResolvedValue({ subject: 's', html: '<p>h</p>', text: 't' }),
}));

import { SendCreditDueTodayAlertAction } from '../actions/send-credit-due-today-alert.action';
import type { GetCreditsDueTodayAction } from '../actions/get-credits-due-today.action';
import type { AlertPdfTokenService } from '../internal/alert-pdf-token.service';
import type { CreditsDueTodaySummary } from '../internal/credits-due-today';
import type { User } from '@/modules/users/entities/user.entity';
import type { Company } from '@/modules/companies/entities/company.entity';
import type { MailService } from '@/modules/mail/mail.service';

const CFG = {
  apiPublicUrl: 'http://api.test',
  pdfTokenSecret: 's',
  pdfTokenExpiresIn: '7d',
  cronEnabled: false,
  cronExpression: '0 7 * * *',
};

interface Deps {
  owner?: { id: string; email: string } | null;
  summary?: CreditsDueTodaySummary;
  mailEnabled?: boolean;
}

function build(deps: Deps = {}) {
  const owner = deps.owner === undefined ? { id: '5', email: 'owner@x.com' } : deps.owner;
  const usersRepo = { findOne: jest.fn().mockResolvedValue(owner) } as unknown as Repository<User>;
  const companiesRepo = {
    findOne: jest.fn().mockResolvedValue({ name: 'Esencia' }),
  } as unknown as Repository<Company>;
  const getCreditsDueToday = {
    execute: jest.fn().mockResolvedValue(
      deps.summary ?? { date: '2026-10-03', rows: [], count: 0, totalBalance: 0 },
    ),
  } as unknown as GetCreditsDueTodayAction;
  const send = jest.fn().mockResolvedValue({ messageId: 'm' });
  const mailService = {
    isEnabled: jest.fn().mockReturnValue(deps.mailEnabled ?? true),
    send,
  } as unknown as MailService;
  const tokenService = {
    sign: jest.fn().mockResolvedValue('signed-token'),
  } as unknown as AlertPdfTokenService;
  const config = { getOrThrow: () => CFG } as unknown as ConfigService;

  const action = new SendCreditDueTodayAlertAction(
    usersRepo,
    companiesRepo,
    getCreditsDueToday,
    mailService,
    tokenService,
    config,
  );
  return { action, send, tokenService, getCreditsDueToday };
}

const withCredits: CreditsDueTodaySummary = {
  date: '2026-10-03',
  rows: [
    {
      customerName: 'Ana',
      ticketNumber: 'V-1',
      saleDate: '2026-09-20',
      registeredBy: 'Cajero 1',
      totalAmount: 100,
      paidAmount: 40,
      balance: 60,
      dueDate: '2026-10-03',
    },
  ],
  count: 1,
  totalBalance: 60,
};

describe('SendCreditDueTodayAlertAction', () => {
  it('NO envía si no hay créditos que venzan hoy (real)', async () => {
    const { action, send } = build({ summary: { date: '2026-10-03', rows: [], count: 0, totalBalance: 0 } });
    const result = await action.execute(8);
    expect(result.sent).toBe(false);
    expect(result.reason).toBe('no-credits');
    expect(send).not.toHaveBeenCalled();
  });

  it('envía cuando hay créditos reales que vencen hoy', async () => {
    const { action, send, tokenService } = build({ summary: withCredits });
    const result = await action.execute(8);
    expect(result.sent).toBe(true);
    expect(result.recipientEmail).toBe('owner@x.com');
    expect(result.count).toBe(1);
    expect(send).toHaveBeenCalledTimes(1);
    // El correo va SOLO al owner.
    expect((send as jest.Mock).mock.calls[0][0].to).toBe('owner@x.com');
    // Token SIN mock en envío real.
    expect((tokenService.sign as jest.Mock).mock.calls[0][0].mock).toBeUndefined();
  });

  it('mock=true SIEMPRE envía (aunque no haya créditos reales)', async () => {
    const { action, send, tokenService, getCreditsDueToday } = build();
    const result = await action.execute(8, { mock: true });
    expect(result.sent).toBe(true);
    expect(send).toHaveBeenCalledTimes(1);
    // En mock no se consulta la BD.
    expect(getCreditsDueToday.execute).not.toHaveBeenCalled();
    expect((tokenService.sign as jest.Mock).mock.calls[0][0].mock).toBe(true);
  });

  it('no envía si la company no tiene owner', async () => {
    const { action, send } = build({ owner: null });
    const result = await action.execute(8);
    expect(result.sent).toBe(false);
    expect(result.reason).toBe('no-owner');
    expect(send).not.toHaveBeenCalled();
  });

  it('no envía si el correo está deshabilitado', async () => {
    const { action, send } = build({ summary: withCredits, mailEnabled: false });
    const result = await action.execute(8);
    expect(result.sent).toBe(false);
    expect(result.reason).toBe('mail-disabled');
    expect(send).not.toHaveBeenCalled();
  });
});
