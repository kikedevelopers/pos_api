import { JwtService } from '@nestjs/jwt';
import type { ConfigService } from '@nestjs/config';

import { AlertPdfTokenService } from '../internal/alert-pdf-token.service';
import { ALERT_TYPE_CREDIT_DUE_TODAY } from '../constants';

describe('AlertPdfTokenService', () => {
  const cfg = {
    apiPublicUrl: 'http://api.test',
    pdfTokenSecret: 'secret-under-test',
    pdfTokenExpiresIn: '7d',
    cronEnabled: false,
    cronExpression: '0 7 * * *',
  };
  const makeService = (overrides: Partial<typeof cfg> = {}): AlertPdfTokenService => {
    const config = { getOrThrow: () => ({ ...cfg, ...overrides }) } as unknown as ConfigService;
    return new AlertPdfTokenService(new JwtService({}), config);
  };

  it('firma y verifica (roundtrip) conservando el payload', async () => {
    const service = makeService();
    const token = await service.sign({
      cid: 8,
      uid: 5,
      date: '2026-10-03',
      type: ALERT_TYPE_CREDIT_DUE_TODAY,
    });
    const payload = await service.verify(token);
    expect(payload.cid).toBe(8);
    expect(payload.uid).toBe(5);
    expect(payload.date).toBe('2026-10-03');
    expect(payload.type).toBe(ALERT_TYPE_CREDIT_DUE_TODAY);
  });

  it('conserva el flag mock cuando se incluye', async () => {
    const service = makeService();
    const token = await service.sign({
      cid: 1,
      uid: 1,
      date: '2026-10-03',
      type: ALERT_TYPE_CREDIT_DUE_TODAY,
      mock: true,
    });
    expect((await service.verify(token)).mock).toBe(true);
  });

  it('rechaza un token firmado con OTRO secreto', async () => {
    const signer = makeService({ pdfTokenSecret: 'secret-A' });
    const token = await signer.sign({ cid: 1, uid: 1, date: '2026-10-03', type: ALERT_TYPE_CREDIT_DUE_TODAY });
    const verifier = makeService({ pdfTokenSecret: 'secret-B' });
    await expect(verifier.verify(token)).rejects.toBeDefined();
  });

  it('rechaza un token manipulado', async () => {
    const service = makeService();
    const token = await service.sign({ cid: 1, uid: 1, date: '2026-10-03', type: ALERT_TYPE_CREDIT_DUE_TODAY });
    await expect(service.verify(token + 'x')).rejects.toBeDefined();
  });
});
