import {
  buildFileStatusUrl,
  buildUploadStartUrl,
  GeminiFilesClient,
  GeminiFileUploadError,
  parseUploadedFile,
} from '../internal/gemini-files';

const BASE = 'https://generativelanguage.googleapis.com/v1beta';

const clientWith = (apiKey = 'k3y'): GeminiFilesClient =>
  new GeminiFilesClient({
    getOrThrow: () => ({ apiKey, baseUrl: BASE, requestTimeoutMs: 5_000 }),
  } as never);

const jsonResponse = (body: unknown, init: ResponseInit = {}): Response =>
  new Response(JSON.stringify(body), { status: 200, ...init });

describe('URLs del Files API', () => {
  it('la subida vive en /upload sobre el mismo origen y versión', () => {
    expect(buildUploadStartUrl(BASE, 'a b')).toBe(
      'https://generativelanguage.googleapis.com/upload/v1beta/files?key=a%20b',
    );
    expect(buildUploadStartUrl(`${BASE}/`, 'k')).toBe(
      'https://generativelanguage.googleapis.com/upload/v1beta/files?key=k',
    );
  });

  it('el estado se consulta por el nombre del recurso y rechaza nombres raros', () => {
    expect(buildFileStatusUrl(BASE, 'files/abc-1_2', 'k')).toBe(`${BASE}/files/abc-1_2?key=k`);
    expect(() => buildFileStatusUrl(BASE, 'files/../../models', 'k')).toThrow(
      GeminiFileUploadError,
    );
    expect(() => buildFileStatusUrl(BASE, 'https://evil/x', 'k')).toThrow(GeminiFileUploadError);
  });
});

describe('parseUploadedFile', () => {
  it('lee el archivo envuelto ({ file }) y directo', () => {
    const file = { name: 'files/a', uri: 'u', mimeType: 'application/pdf', state: 'ACTIVE' };
    expect(parseUploadedFile({ file })).toMatchObject(file);
    expect(parseUploadedFile(file)).toMatchObject(file);
  });

  it('devuelve null si falta el nombre o la URI', () => {
    expect(parseUploadedFile({ file: { name: 'files/a' } })).toBeNull();
    expect(parseUploadedFile({ file: { uri: 'u' } })).toBeNull();
    expect(parseUploadedFile(null)).toBeNull();
    expect(parseUploadedFile('x')).toBeNull();
  });
});

describe('GeminiFilesClient.upload', () => {
  const fetchMock = jest.fn();
  const original = global.fetch;
  beforeEach(() => {
    fetchMock.mockReset();
    global.fetch = fetchMock as never;
  });
  afterAll(() => {
    global.fetch = original;
  });

  const params = {
    buffer: Buffer.from('%PDF-1.7 hola'),
    mime_type: 'application/pdf',
    display_name: 'f.pdf',
  };

  it('sube en dos pasos (start → upload, finalize) y devuelve el archivo ACTIVE', async () => {
    fetchMock
      .mockResolvedValueOnce(
        new Response(null, { status: 200, headers: { 'x-goog-upload-url': 'https://up/1' } }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          file: {
            name: 'files/x1',
            uri: 'https://g/files/x1',
            mimeType: 'application/pdf',
            state: 'ACTIVE',
            expirationTime: '2026-10-29T10:00:00Z',
          },
        }),
      );

    const file = await clientWith().upload(params);

    expect(file).toMatchObject({ name: 'files/x1', uri: 'https://g/files/x1', state: 'ACTIVE' });
    const calls = fetchMock.mock.calls as Array<[string, { headers: Record<string, string> }]>;
    const [start_url, start_init] = calls[0];
    expect(start_url).toContain('/upload/v1beta/files?key=k3y');
    expect(start_init.headers['X-Goog-Upload-Command']).toBe('start');
    expect(start_init.headers['X-Goog-Upload-Header-Content-Type']).toBe('application/pdf');
    expect(start_init.headers['X-Goog-Upload-Header-Content-Length']).toBe(
      String(params.buffer.length),
    );
    const [upload_url, upload_init] = calls[1];
    expect(upload_url).toBe('https://up/1');
    expect(upload_init.headers['X-Goog-Upload-Command']).toBe('upload, finalize');
  });

  it('espera mientras el archivo está PROCESSING', async () => {
    jest.useFakeTimers();
    fetchMock
      .mockResolvedValueOnce(
        new Response(null, { headers: { 'x-goog-upload-url': 'https://up/1' } }),
      )
      .mockResolvedValueOnce(
        jsonResponse({ file: { name: 'files/x1', uri: 'u', state: 'PROCESSING' } }),
      )
      .mockResolvedValueOnce(jsonResponse({ name: 'files/x1', uri: 'u', state: 'ACTIVE' }));

    const promise = clientWith().upload(params);
    await jest.advanceTimersByTimeAsync(1_100);
    await expect(promise).resolves.toMatchObject({ state: 'ACTIVE' });
    expect((fetchMock.mock.calls as string[][])[2][0]).toBe(`${BASE}/files/x1?key=k3y`);
    jest.useRealTimers();
  });

  it('sin llave no llama a Google (503)', async () => {
    await expect(clientWith('').upload(params)).rejects.toMatchObject({ status: 503 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('si el inicio no trae URL de subida → 503', async () => {
    fetchMock.mockResolvedValueOnce(new Response('no', { status: 500 }));
    await expect(clientWith().upload(params)).rejects.toMatchObject({ status: 503 });
  });

  it('si Google rechaza los bytes (4xx) → 422, archivo ilegible', async () => {
    fetchMock
      .mockResolvedValueOnce(
        new Response(null, { headers: { 'x-goog-upload-url': 'https://up/1' } }),
      )
      .mockResolvedValueOnce(new Response('{"error":{}}', { status: 400 }));
    await expect(clientWith().upload(params)).rejects.toMatchObject({ status: 422 });
  });

  it('si Google marca el archivo FAILED → 422', async () => {
    fetchMock
      .mockResolvedValueOnce(
        new Response(null, { headers: { 'x-goog-upload-url': 'https://up/1' } }),
      )
      .mockResolvedValueOnce(
        jsonResponse({ file: { name: 'files/x1', uri: 'u', state: 'FAILED' } }),
      );
    await expect(clientWith().upload(params)).rejects.toMatchObject({ status: 422 });
  });

  it('un fallo de red se traduce a 503 con mensaje para el usuario', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('fetch failed'));
    const error = await clientWith()
      .upload(params)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GeminiFileUploadError);
    expect((error as GeminiFileUploadError).status).toBe(503);
    expect((error as Error).message).toMatch(/Intenta de nuevo/);
  });
});
