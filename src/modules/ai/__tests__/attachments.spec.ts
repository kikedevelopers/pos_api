import {
  attachmentOnlyText,
  buildAttachmentPartsResolver,
  collectAttachmentIds,
  detectAttachmentMime,
  isAttachmentId,
  MAX_ATTACHMENT_NAME_LENGTH,
  MAX_ATTACHMENTS_PER_REQUEST,
  MAX_ATTACHMENTS_PER_TURN,
  normalizeAttachmentTurns,
  sanitizeAttachmentName,
  turnAttachmentIds,
  type ResolvedAttachment,
} from '../internal/attachments';
import { buildGeminiRequest, hasSendableContent } from '../internal/gemini-request';
import type { ChatTurn } from '../internal/gemini.types';

const uuid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

const withHeader = (header: number[] | string, total = 32): Buffer => {
  const head = typeof header === 'string' ? Buffer.from(header, 'ascii') : Buffer.from(header);
  return Buffer.concat([head, Buffer.alloc(Math.max(0, total - head.length))]);
};

const ftyp = (brand: string): Buffer =>
  withHeader(
    Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from(`ftyp${brand}`)]).toJSON().data,
  );

describe('detectAttachmentMime', () => {
  it.each([
    ['PDF', withHeader('%PDF-1.7\n'), 'application/pdf'],
    ['JPEG', withHeader([0xff, 0xd8, 0xff, 0xe0]), 'image/jpeg'],
    ['PNG', withHeader([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), 'image/png'],
    ['WebP', withHeader('RIFF\u0000\u0000\u0000\u0000WEBPVP8 '), 'image/webp'],
    ['HEIC (heic)', ftyp('heic'), 'image/heic'],
    ['HEIC (hevc)', ftyp('hevc'), 'image/heic'],
    ['HEIF (mif1)', ftyp('mif1'), 'image/heif'],
  ])('reconoce %s por sus bytes', (_label, buffer, expected) => {
    expect(detectAttachmentMime(buffer)).toBe(expected);
  });

  it.each([
    ['HTML disfrazado', withHeader('<!doctype html><html>')],
    ['ZIP / Office', withHeader([0x50, 0x4b, 0x03, 0x04])],
    ['MP4 (ftyp isom)', ftyp('isom')],
    ['GIF', withHeader('GIF89a')],
    ['texto plano', withHeader('factura 123 total 50000')],
  ])('rechaza %s', (_label, buffer) => {
    expect(detectAttachmentMime(buffer)).toBeNull();
  });

  it('rechaza archivos demasiado cortos o que no son Buffer', () => {
    expect(detectAttachmentMime(Buffer.from('%PDF'))).toBeNull();
    expect(detectAttachmentMime('%PDF-1.7 aaaaaaaaaa' as unknown as Buffer)).toBeNull();
  });
});

describe('sanitizeAttachmentName', () => {
  it('quita rutas, controles y corchetes que podrían confundir al prompt', () => {
    expect(sanitizeAttachmentName('C:\\fakepath\\Factura «Abril» [1].pdf', 'application/pdf')).toBe(
      'Factura Abril 1.pdf',
    );
    expect(sanitizeAttachmentName('../../etc/foto\u0000.jpg', 'image/jpeg')).toBe('foto.jpg');
  });

  it('usa un nombre por defecto si viene vacío o no es texto', () => {
    expect(sanitizeAttachmentName('   ', 'application/pdf')).toBe('documento.pdf');
    expect(sanitizeAttachmentName(undefined, 'image/heic')).toBe('foto.heic');
    expect(sanitizeAttachmentName(42, 'image/png')).toBe('imagen.png');
  });

  it('acota el largo conservando el final (la extensión)', () => {
    const name = `${'a'.repeat(300)}.pdf`;
    const result = sanitizeAttachmentName(name, 'application/pdf');
    expect(result).toHaveLength(MAX_ATTACHMENT_NAME_LENGTH);
    expect(result.endsWith('.pdf')).toBe(true);
  });
});

describe('ids de adjuntos', () => {
  it('isAttachmentId solo acepta uuid', () => {
    expect(isAttachmentId(uuid(1))).toBe(true);
    expect(isAttachmentId('files/abc')).toBe(false);
    expect(isAttachmentId('1; DROP TABLE x')).toBe(false);
    expect(isAttachmentId(5)).toBe(false);
  });

  it('turnAttachmentIds ignora inválidos, repetidos y el exceso por turno', () => {
    const ids = [uuid(1), uuid(1).toUpperCase(), 'basura', ...[2, 3, 4, 5, 6, 7].map(uuid)];
    const result = turnAttachmentIds({ role: 'user', content: 'x', attachment_ids: ids });
    expect(result).toEqual([1, 2, 3, 4, 5].map(uuid));
    expect(result).toHaveLength(MAX_ATTACHMENTS_PER_TURN);
  });

  it('collectAttachmentIds solo toma turnos del usuario y reenvía los más recientes', () => {
    const turns: ChatTurn[] = [];
    for (let n = 1; n <= MAX_ATTACHMENTS_PER_REQUEST + 2; n += 1) {
      turns.push({ role: 'user', content: `m${n}`, attachment_ids: [uuid(n)] });
      turns.push({ role: 'assistant', content: 'ok', attachment_ids: [uuid(900)] });
    }
    const { all, included } = collectAttachmentIds(turns);
    expect(all).toHaveLength(MAX_ATTACHMENTS_PER_REQUEST + 2);
    expect(all).not.toContain(uuid(900));
    expect(included.has(uuid(1))).toBe(false);
    expect(included.has(uuid(2))).toBe(false);
    expect(included.has(uuid(MAX_ATTACHMENTS_PER_REQUEST + 2))).toBe(true);
    expect(included.size).toBe(MAX_ATTACHMENTS_PER_REQUEST);
  });
});

describe('normalizeAttachmentTurns', () => {
  it('rellena el texto de un mensaje que solo trae archivos (determinista)', () => {
    const turns: ChatTurn[] = [
      { role: 'user', content: '', attachment_ids: [uuid(1)] },
      { role: 'user', content: '  ', attachment_ids: [uuid(2), uuid(3)] },
    ];
    const result = normalizeAttachmentTurns(turns);
    expect(result[0].content).toBe(attachmentOnlyText(1));
    expect(result[1].content).toBe('(Adjunté 2 archivos)');
    expect(normalizeAttachmentTurns(turns)).toEqual(result);
  });

  it('no toca mensajes con texto, sin adjuntos ni respuestas de Place', () => {
    const turns: ChatTurn[] = [
      { role: 'user', content: 'Analiza esta factura', attachment_ids: [uuid(1)] },
      { role: 'user', content: '' },
      { role: 'assistant', content: '', attachment_ids: [uuid(2)] },
    ];
    expect(normalizeAttachmentTurns(turns)).toEqual(turns);
  });
});

describe('buildAttachmentPartsResolver + buildGeminiRequest', () => {
  const invoice: ResolvedAttachment = {
    id: uuid(1),
    file_name: 'factura.pdf',
    mime_type: 'application/pdf',
    gemini_file_uri: 'https://generativelanguage.googleapis.com/v1beta/files/abc',
  };

  it('pone el archivo ANTES del texto del turno, con su nombre', () => {
    const resolver = buildAttachmentPartsResolver(
      new Map([[uuid(1), invoice]]),
      new Set([uuid(1)]),
    );
    const body = buildGeminiRequest({
      turns: [{ role: 'user', content: 'Extrae los productos', attachment_ids: [uuid(1)] }],
      temperature: 0.5,
      maxOutputTokens: 1024,
      attachmentParts: resolver,
    });
    expect(body.contents).toEqual([
      {
        role: 'user',
        parts: [
          { text: '[Archivo adjunto: «factura.pdf»]' },
          { fileData: { mimeType: 'application/pdf', fileUri: invoice.gemini_file_uri } },
          { text: 'Extrae los productos' },
        ],
      },
    ]);
  });

  it('un id vencido o ajeno se presenta como "no disponible", sin URI', () => {
    const resolver = buildAttachmentPartsResolver(new Map(), new Set([uuid(9)]));
    const parts = resolver({ role: 'user', content: 'x', attachment_ids: [uuid(9)] });
    expect(parts).toHaveLength(1);
    expect(parts[0].text).toMatch(/ya no está disponible/);
    expect(parts[0].fileData).toBeUndefined();
  });

  it('un adjunto viejo (fuera de los reenviados) se menciona sin reenviarse', () => {
    const resolver = buildAttachmentPartsResolver(new Map([[uuid(1), invoice]]), new Set());
    const parts = resolver({ role: 'user', content: 'x', attachment_ids: [uuid(1)] });
    expect(parts).toEqual([{ text: expect.stringMatching(/«factura\.pdf» adjuntado antes/) }]);
  });

  it('las respuestas de Place nunca llevan archivos', () => {
    const resolver = buildAttachmentPartsResolver(
      new Map([[uuid(1), invoice]]),
      new Set([uuid(1)]),
    );
    expect(resolver({ role: 'assistant', content: 'x', attachment_ids: [uuid(1)] })).toEqual([]);
  });

  it('al fusionar turnos seguidos del usuario conserva el archivo del segundo', () => {
    const resolver = buildAttachmentPartsResolver(
      new Map([[uuid(1), invoice]]),
      new Set([uuid(1)]),
    );
    const body = buildGeminiRequest({
      turns: [
        { role: 'user', content: 'Hola' },
        { role: 'user', content: 'Mira esto', attachment_ids: [uuid(1)] },
        { role: 'user', content: 'y dime' },
      ],
      temperature: 0.5,
      maxOutputTokens: 1024,
      attachmentParts: resolver,
    });
    expect(body.contents).toHaveLength(1);
    const parts = body.contents[0].parts;
    expect(parts[0]).toEqual({ text: 'Hola' });
    expect(parts[2].fileData?.fileUri).toBe(invoice.gemini_file_uri);
    expect(parts[3]).toEqual({ text: 'Mira esto\n\ny dime' });
  });

  it('hasSendableContent acepta un turno con archivo', () => {
    expect(
      hasSendableContent({
        contents: [
          { role: 'user', parts: [{ fileData: { mimeType: 'image/png', fileUri: 'u' } }] },
        ],
        generationConfig: { temperature: 0, topP: 1, maxOutputTokens: 256 },
      }),
    ).toBe(true);
    expect(
      hasSendableContent({
        contents: [{ role: 'model', parts: [{ text: 'hola' }] }],
        generationConfig: { temperature: 0, topP: 1, maxOutputTokens: 256 },
      }),
    ).toBe(false);
  });
});
