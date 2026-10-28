import { createHash } from 'node:crypto';

import type { WompiEvent } from '../../wompi/wompi.types';
import { computeEventChecksum, readPath, verifyEventSignature } from '../wompi-signature';

const SECRET = 'test_events_secret';

/** Evento como el del ejemplo de la documentación de Wompi. */
function buildEvent(overrides: Partial<WompiEvent> = {}): WompiEvent {
  const event: WompiEvent = {
    event: 'transaction.updated',
    data: {
      transaction: {
        id: '1234-1610641025-49201',
        amount_in_cents: 4490000,
        status: 'APPROVED',
        payment_link_id: 'abc123',
      },
    },
    environment: 'test',
    signature: {
      properties: ['transaction.id', 'transaction.status', 'transaction.amount_in_cents'],
      checksum: '',
    },
    timestamp: 1530291411,
    ...overrides,
  };
  if (event.signature && overrides.signature === undefined) {
    event.signature.checksum = createHash('sha256')
      .update(`1234-1610641025-49201APPROVED44900001530291411${SECRET}`)
      .digest('hex');
  }
  return event;
}

describe('readPath', () => {
  it('lee rutas anidadas y devuelve undefined si no existen', () => {
    expect(readPath({ a: { b: 3 } }, 'a.b')).toBe(3);
    expect(readPath({ a: null }, 'a.b')).toBeUndefined();
    expect(readPath({}, 'x.y')).toBeUndefined();
  });
});

describe('verifyEventSignature', () => {
  it('acepta un evento firmado con el algoritmo de Wompi', () => {
    const event = buildEvent();
    expect(computeEventChecksum(event, SECRET)).toBe(event.signature?.checksum);
    expect(verifyEventSignature(event, SECRET)).toBe(true);
  });

  it('acepta el checksum del header aunque coincida en mayúsculas', () => {
    const event = buildEvent();
    const checksum = String(event.signature?.checksum);
    expect(verifyEventSignature(event, SECRET, checksum.toUpperCase())).toBe(true);
  });

  it('rechaza un monto alterado (alguien cambia el evento y no la firma)', () => {
    const event = buildEvent();
    (event.data.transaction as { amount_in_cents: number }).amount_in_cents = 100;
    expect(verifyEventSignature(event, SECRET)).toBe(false);
  });

  it('rechaza un estado alterado (DECLINED → APPROVED)', () => {
    const event = buildEvent();
    const checksumForDeclined = createHash('sha256')
      .update(`1234-1610641025-49201DECLINED44900001530291411${SECRET}`)
      .digest('hex');
    event.signature = { ...event.signature, checksum: checksumForDeclined };
    expect(verifyEventSignature(event, SECRET)).toBe(false);
  });

  it('rechaza con otro secreto', () => {
    expect(verifyEventSignature(buildEvent(), 'otro_secreto')).toBe(false);
  });

  it('rechaza si el header contradice al cuerpo', () => {
    expect(verifyEventSignature(buildEvent(), SECRET, 'a'.repeat(64))).toBe(false);
  });

  it('rechaza eventos sin firma, sin propiedades, sin timestamp o sin secreto', () => {
    expect(verifyEventSignature(buildEvent({ signature: undefined }), SECRET)).toBe(false);
    expect(
      verifyEventSignature(buildEvent({ signature: { properties: [], checksum: 'x' } }), SECRET),
    ).toBe(false);
    expect(verifyEventSignature(buildEvent({ timestamp: undefined }), SECRET)).toBe(false);
    expect(verifyEventSignature(buildEvent(), '')).toBe(false);
  });

  it('rechaza si una propiedad firmada no existe o es un objeto', () => {
    const missing = buildEvent();
    missing.signature = { properties: ['transaction.nope'], checksum: 'x' };
    expect(verifyEventSignature(missing, SECRET)).toBe(false);

    const objectValue = buildEvent();
    objectValue.signature = { properties: ['transaction'], checksum: 'x' };
    expect(verifyEventSignature(objectValue, SECRET)).toBe(false);
  });
});
