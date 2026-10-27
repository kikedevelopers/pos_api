import { HttpException, HttpStatus } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import { AiAttachmentsAction, attachmentExpiry } from '../actions/ai-attachments.action';
import { AiChatRequestDto } from '../dto/ai-chat.dto';
import { MAX_ATTACHMENT_BYTES } from '../internal/attachments';
import { GeminiFileUploadError } from '../internal/gemini-files';

const PDF = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(64)]);
const ID = '11111111-1111-4111-8111-111111111111';

const build = (
  opts: { upload?: jest.Mock } = {},
): { action: AiAttachmentsAction; query: jest.Mock; upload: jest.Mock } => {
  const query = jest.fn((sql: string, _params?: unknown[]) => {
    if (/INSERT INTO ai_attachments/.test(sql)) {
      return Promise.resolve([{ id: ID, expires_at: new Date('2026-10-29T08:00:00Z') }]);
    }
    if (/SELECT id::text AS id/.test(sql)) {
      return Promise.resolve([
        {
          id: ID.toUpperCase(),
          file_name: 'f.pdf',
          mime_type: 'application/pdf',
          gemini_file_uri: 'u',
        },
      ]);
    }
    return Promise.resolve([]);
  });
  const upload =
    opts.upload ??
    jest.fn().mockResolvedValue({
      name: 'files/x',
      uri: 'https://g/files/x',
      mimeType: 'application/pdf',
      state: 'ACTIVE',
      expirationTime: '2026-10-29T10:00:00Z',
    });
  const action = new AiAttachmentsAction({ query } as never, { upload } as never);
  return { action, query, upload };
};

describe('AiAttachmentsAction.upload', () => {
  it('detecta el tipo por los bytes, sube a Google y guarda solo metadatos del dueño', async () => {
    const { action, query, upload } = build();
    const view = await action.upload({
      company_id: 7,
      user_id: 3,
      file: { originalname: 'C:\\x\\Factura.pdf', buffer: PDF },
    });

    expect(upload).toHaveBeenCalledWith({
      buffer: PDF,
      mime_type: 'application/pdf',
      display_name: 'Factura.pdf',
    });
    const [sql, params] = (query.mock.calls as Array<[string, unknown[]]>).find(([s]) =>
      /INSERT/.test(s),
    ) as [string, unknown[]];
    expect(sql).toMatch(/INSERT INTO ai_attachments/);
    expect(params.slice(0, 7)).toEqual([
      '7',
      '3',
      'Factura.pdf',
      'application/pdf',
      PDF.length,
      'files/x',
      'https://g/files/x',
    ]);
    expect(view).toEqual({
      id: ID,
      file_name: 'Factura.pdf',
      mime_type: 'application/pdf',
      size_bytes: PDF.length,
      expires_at: '2026-10-29T08:00:00.000Z',
    });
    // Nunca se le devuelve al cliente la URI de Google.
    expect(JSON.stringify(view)).not.toContain('files/x');
  });

  it('purga los adjuntos vencidos de la company', async () => {
    const { action, query } = build();
    await action.upload({ company_id: 7, user_id: 3, file: { buffer: PDF } });
    expect(
      (query.mock.calls as Array<[string]>).some(([sql]) => /DELETE FROM ai_attachments/.test(sql)),
    ).toBe(true);
  });

  it('sin archivo → 400', async () => {
    const { action, upload } = build();
    await expect(
      action.upload({ company_id: 7, user_id: 3, file: undefined }),
    ).rejects.toMatchObject({
      status: HttpStatus.BAD_REQUEST,
    });
    await expect(
      action.upload({ company_id: 7, user_id: 3, file: { buffer: Buffer.alloc(0) } }),
    ).rejects.toMatchObject({ status: HttpStatus.BAD_REQUEST });
    expect(upload).not.toHaveBeenCalled();
  });

  it('más grande que el límite → 413, sin subir', async () => {
    const { action, upload } = build();
    const big = Buffer.concat([PDF, Buffer.alloc(MAX_ATTACHMENT_BYTES)]);
    await expect(
      action.upload({ company_id: 7, user_id: 3, file: { buffer: big } }),
    ).rejects.toMatchObject({
      status: HttpStatus.PAYLOAD_TOO_LARGE,
    });
    expect(upload).not.toHaveBeenCalled();
  });

  it('un .pdf que no es PDF (HTML disfrazado) → 422, sin subir', async () => {
    const { action, upload } = build();
    const fake = Buffer.from('<html><script>alert(1)</script></html>');
    await expect(
      action.upload({ company_id: 7, user_id: 3, file: { originalname: 'f.pdf', buffer: fake } }),
    ).rejects.toMatchObject({ status: HttpStatus.UNPROCESSABLE_ENTITY });
    expect(upload).not.toHaveBeenCalled();
  });

  it.each([
    [422, HttpStatus.UNPROCESSABLE_ENTITY],
    [503, HttpStatus.SERVICE_UNAVAILABLE],
  ] as const)('traduce el fallo de Google %s a HTTP', async (status, http) => {
    const { action, query } = build({
      upload: jest.fn().mockRejectedValue(new GeminiFileUploadError('msg', status)),
    });
    const error = await action
      .upload({ company_id: 7, user_id: 3, file: { buffer: PDF } })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HttpException);
    expect((error as HttpException).getStatus()).toBe(http);
    expect(query).not.toHaveBeenCalled();
  });
});

describe('AiAttachmentsAction.resolve', () => {
  it('filtra por company, usuario y vigencia; ignora ids inválidos', async () => {
    const { action, query } = build();
    const result = await action.resolve(7, 3, [ID, 'basura']);
    const [sql, params] = (query.mock.calls as Array<[string, unknown[]]>)[0];
    expect(sql).toMatch(/company_id = \$1/);
    expect(sql).toMatch(/user_id = \$2/);
    expect(sql).toMatch(/expires_at > now\(\)/);
    expect(params).toEqual(['7', '3', [ID]]);
    expect(result.get(ID)?.gemini_file_uri).toBe('u');
  });

  it('sin ids válidos no consulta la BD', async () => {
    const { action, query } = build();
    expect((await action.resolve(7, 3, ['x'])).size).toBe(0);
    expect(query).not.toHaveBeenCalled();
  });
});

describe('attachmentExpiry', () => {
  const now = new Date('2026-10-27T10:00:00Z');

  it('47 horas cuando Google conserva el archivo más tiempo', () => {
    expect(attachmentExpiry(now, '2026-10-29T10:00:00Z').toISOString()).toBe(
      '2026-10-29T09:00:00.000Z',
    );
  });

  it('una hora antes de que Google lo borre si eso es antes', () => {
    expect(attachmentExpiry(now, '2026-10-28T10:00:00Z').toISOString()).toBe(
      '2026-10-28T09:00:00.000Z',
    );
  });

  it('sin fecha de Google (o inválida) → 47 horas', () => {
    expect(attachmentExpiry(now).toISOString()).toBe('2026-10-29T09:00:00.000Z');
    expect(attachmentExpiry(now, 'mañana').toISOString()).toBe('2026-10-29T09:00:00.000Z');
  });
});

describe('AiChatRequestDto con adjuntos', () => {
  const errorsOf = async (turns: unknown[]): Promise<string[]> => {
    const errors = await validate(plainToInstance(AiChatRequestDto, { turns }));
    return errors.flatMap((e) =>
      (e.children ?? []).flatMap((c) =>
        (c.children ?? []).flatMap((cc) => Object.values(cc.constraints ?? {})),
      ),
    );
  };

  it('acepta texto vacío si el turno trae archivos', async () => {
    expect(await errorsOf([{ role: 'user', content: '', attachment_ids: [ID] }])).toEqual([]);
  });

  it('rechaza texto vacío sin archivos', async () => {
    expect(await errorsOf([{ role: 'user', content: '  ' }])).toContain(
      'El mensaje no puede estar vacío',
    );
    expect(await errorsOf([{ role: 'user', content: '', attachment_ids: [] }])).toContain(
      'El mensaje no puede estar vacío',
    );
  });

  it('rechaza ids que no son uuid y más de 5 por mensaje', async () => {
    expect(
      await errorsOf([{ role: 'user', content: 'x', attachment_ids: ['files/abc'] }]),
    ).toContain('La referencia del archivo adjunto es inválida');
    const six = Array.from({ length: 6 }, (_, i) => `11111111-1111-4111-8111-11111111111${i}`);
    expect(await errorsOf([{ role: 'user', content: 'x', attachment_ids: six }])).toContain(
      'No puedes adjuntar más de 5 archivos por mensaje',
    );
  });

  it('el contenido sigue debiendo ser texto aunque traiga archivos', async () => {
    expect(await errorsOf([{ role: 'user', content: 5, attachment_ids: [ID] }])).toContain(
      'El contenido del mensaje debe ser texto',
    );
  });
});
