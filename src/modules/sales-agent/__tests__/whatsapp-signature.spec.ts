import { createHmac } from 'node:crypto';

import { verifyWhatsappSignature } from '../channels/whatsapp/whatsapp-signature';

const SECRET = 'app-secret-123';
const sign = (body: string, secret = SECRET): string =>
  'sha256=' + createHmac('sha256', secret).update(Buffer.from(body, 'utf8')).digest('hex');

describe('verifyWhatsappSignature', () => {
  const body = JSON.stringify({ object: 'whatsapp_business_account', entry: [] });

  it('acepta una firma válida (header con prefijo sha256=)', () => {
    expect(verifyWhatsappSignature(Buffer.from(body), sign(body), SECRET)).toBe(true);
  });

  it('acepta el cuerpo como string además de Buffer', () => {
    expect(verifyWhatsappSignature(body, sign(body), SECRET)).toBe(true);
  });

  it('acepta el header sin el prefijo sha256=', () => {
    const hex = createHmac('sha256', SECRET).update(Buffer.from(body)).digest('hex');
    expect(verifyWhatsappSignature(Buffer.from(body), hex, SECRET)).toBe(true);
  });

  it('rechaza una firma de otro secreto', () => {
    expect(verifyWhatsappSignature(Buffer.from(body), sign(body, 'otro'), SECRET)).toBe(false);
  });

  it('rechaza si el cuerpo cambió', () => {
    expect(verifyWhatsappSignature(Buffer.from(body + ' '), sign(body), SECRET)).toBe(false);
  });

  it('rechaza sin secreto, sin header o sin cuerpo', () => {
    expect(verifyWhatsappSignature(Buffer.from(body), sign(body), '')).toBe(false);
    expect(verifyWhatsappSignature(Buffer.from(body), undefined, SECRET)).toBe(false);
    expect(verifyWhatsappSignature(undefined, sign(body), SECRET)).toBe(false);
  });

  it('rechaza un header con largo distinto sin lanzar', () => {
    expect(verifyWhatsappSignature(Buffer.from(body), 'sha256=abc', SECRET)).toBe(false);
  });
});
