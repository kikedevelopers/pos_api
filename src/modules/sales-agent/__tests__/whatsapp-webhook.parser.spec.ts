import { parseWhatsappWebhook } from '../channels/whatsapp/whatsapp-webhook.parser';

const textEvent = (overrides?: {
  phoneNumberId?: string;
  from?: string;
  body?: string;
  name?: string;
  id?: string;
}) => ({
  object: 'whatsapp_business_account',
  entry: [
    {
      id: 'waba-1',
      changes: [
        {
          field: 'messages',
          value: {
            messaging_product: 'whatsapp',
            metadata: {
              display_phone_number: '573001112233',
              phone_number_id: overrides?.phoneNumberId ?? '111222333',
            },
            contacts: [
              { profile: { name: overrides?.name ?? 'María' }, wa_id: overrides?.from ?? '573009998877' },
            ],
            messages: [
              {
                from: overrides?.from ?? '573009998877',
                id: overrides?.id ?? 'wamid.ABC',
                timestamp: '1700000000',
                type: 'text',
                text: { body: overrides?.body ?? '  Hola, ¿tienes arroz?  ' },
              },
            ],
          },
        },
      ],
    },
  ],
});

describe('parseWhatsappWebhook', () => {
  it('extrae un mensaje de texto con su phone_number_id y el nombre del remitente', () => {
    expect(parseWhatsappWebhook(textEvent())).toEqual([
      {
        phoneNumberId: '111222333',
        from: '573009998877',
        text: 'Hola, ¿tienes arroz?',
        senderName: 'María',
        messageId: 'wamid.ABC',
      },
    ]);
  });

  it('ignora eventos de estado (statuses) sin mensajes', () => {
    const statusEvent = {
      object: 'whatsapp_business_account',
      entry: [
        {
          changes: [
            {
              field: 'messages',
              value: {
                metadata: { phone_number_id: '111' },
                statuses: [{ id: 'wamid.X', status: 'delivered' }],
              },
            },
          ],
        },
      ],
    };
    expect(parseWhatsappWebhook(statusEvent)).toEqual([]);
  });

  it('ignora mensajes que no son de texto (imagen/audio)', () => {
    const imageEvent = {
      object: 'whatsapp_business_account',
      entry: [
        {
          changes: [
            {
              value: {
                metadata: { phone_number_id: '111' },
                messages: [{ from: '57300', id: 'wamid.IMG', type: 'image', image: { id: 'x' } }],
              },
            },
          ],
        },
      ],
    };
    expect(parseWhatsappWebhook(imageEvent)).toEqual([]);
  });

  it('descarta un mensaje de texto vacío', () => {
    expect(parseWhatsappWebhook(textEvent({ body: '   ' }))).toEqual([]);
  });

  it('sin phone_number_id no devuelve nada', () => {
    const noMeta = {
      entry: [{ changes: [{ value: { messages: [{ from: '1', id: 'a', type: 'text', text: { body: 'hola' } }] } }] }],
    };
    expect(parseWhatsappWebhook(noMeta)).toEqual([]);
  });

  it('ante payloads inválidos devuelve lista vacía (no lanza)', () => {
    expect(parseWhatsappWebhook(undefined)).toEqual([]);
    expect(parseWhatsappWebhook(null)).toEqual([]);
    expect(parseWhatsappWebhook({})).toEqual([]);
    expect(parseWhatsappWebhook({ entry: 'nope' })).toEqual([]);
  });

  it('mensaje sin nombre en contacts queda sin senderName', () => {
    const noContact = {
      entry: [
        {
          changes: [
            {
              value: {
                metadata: { phone_number_id: '999' },
                messages: [{ from: '57301', id: 'wamid.N', type: 'text', text: { body: 'hola' } }],
              },
            },
          ],
        },
      ],
    };
    expect(parseWhatsappWebhook(noContact)).toEqual([
      { phoneNumberId: '999', from: '57301', text: 'hola', senderName: undefined, messageId: 'wamid.N' },
    ]);
  });
});
