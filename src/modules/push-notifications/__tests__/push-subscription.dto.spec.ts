import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import { RemovePushSubscriptionDto, SavePushSubscriptionDto } from '../dto/push-subscription.dto';

const errorsOf = async (payload: unknown) =>
  validate(plainToInstance(SavePushSubscriptionDto, payload));

const valid = {
  endpoint: 'https://fcm.googleapis.com/fcm/send/abc',
  keys: { p256dh: 'BPk', auth: 'xyz' },
};

describe('SavePushSubscriptionDto', () => {
  it('acepta la suscripción del navegador', async () => {
    expect(await errorsOf(valid)).toHaveLength(0);
    expect(await errorsOf({ ...valid, user_agent: 'iPhone' })).toHaveLength(0);
  });

  it.each([
    ['sin endpoint', { keys: valid.keys }],
    ['endpoint no https', { ...valid, endpoint: 'http://push.example/1' }],
    ['endpoint que no es URL', { ...valid, endpoint: 'nada' }],
    ['sin llaves', { endpoint: valid.endpoint }],
    ['llave vacía', { ...valid, keys: { p256dh: '', auth: 'x' } }],
    ['user_agent larguísimo', { ...valid, user_agent: 'x'.repeat(301) }],
  ])('rechaza: %s', async (_label, payload) => {
    expect((await errorsOf(payload)).length).toBeGreaterThan(0);
  });
});

describe('RemovePushSubscriptionDto', () => {
  it('exige el endpoint', async () => {
    expect(await validate(plainToInstance(RemovePushSubscriptionDto, {}))).not.toHaveLength(0);
    expect(
      await validate(plainToInstance(RemovePushSubscriptionDto, { endpoint: valid.endpoint })),
    ).toHaveLength(0);
  });
});
