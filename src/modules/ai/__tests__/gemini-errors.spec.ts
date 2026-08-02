import {
  describeHttpFailure,
  describeTransportFailure,
  extractApiErrorDetail,
  isRetriableHttpFailure,
} from '../internal/gemini-errors';

const googleError = (message: string): string => JSON.stringify({ error: { message } });

describe('describeHttpFailure', () => {
  it('distingue una llave inválida de un 400 genérico', () => {
    expect(
      describeHttpFailure(400, googleError('API key not valid. Please pass a valid API key.')),
    ).toContain('llave de la IA no es válida');
    expect(describeHttpFailure(400, googleError('Invalid JSON payload'))).toContain('inválida');
  });

  it('explica 401/403 como problema de permisos del servidor', () => {
    expect(describeHttpFailure(401)).toContain('permiso');
    expect(describeHttpFailure(403)).toContain('permiso');
  });

  it('explica 404 como modelo no disponible SOLO si Google lo dice', () => {
    expect(describeHttpFailure(404, googleError('models/x is not found'))).toContain(
      'modelo de IA configurado',
    );
  });

  it('no culpa al modelo cuando el 404 llega sin explicación', () => {
    // Google devuelve este 404 fantasma (cuerpo vacío) cuando el proyecto está
    // sin cuota; la misma llamada responde 429 al reintentar.
    for (const body of ['', '   ', 'not json']) {
      const message = describeHttpFailure(404, body);
      expect(message).not.toContain('GEMINI_DEFAULT_MODEL');
      expect(message).toContain('temporal');
    }
  });

  it('distingue el 429 por créditos agotados del 429 por rate limit', () => {
    expect(
      describeHttpFailure(429, googleError('Your prepayment credits are depleted.')),
    ).toContain('sin créditos');
    expect(describeHttpFailure(429, googleError('Resource has been exhausted'))).toContain(
      'límite de uso',
    );
  });

  it('trata los 5xx como caída del proveedor', () => {
    expect(describeHttpFailure(500)).toContain('no está disponible');
    expect(describeHttpFailure(503)).toContain('no está disponible');
  });

  it('tiene un mensaje por defecto para status raros', () => {
    expect(describeHttpFailure(418)).toContain('No se pudo obtener respuesta');
  });

  it('nunca filtra el cuerpo crudo al usuario', () => {
    const message = describeHttpFailure(400, 'esto no es json <html>');
    expect(message).not.toContain('<html>');
  });
});

describe('isRetriableHttpFailure', () => {
  it('reintenta los 5xx', () => {
    expect(isRetriableHttpFailure(500)).toBe(true);
    expect(isRetriableHttpFailure(503, googleError('overloaded'))).toBe(true);
  });

  it('reintenta el 404 sin explicación', () => {
    expect(isRetriableHttpFailure(404, '')).toBe(true);
    expect(isRetriableHttpFailure(404, 'basura no json')).toBe(true);
  });

  it('NO reintenta un 404 que sí explica que el modelo no existe', () => {
    expect(isRetriableHttpFailure(404, googleError('models/x is not found'))).toBe(false);
  });

  it('NO reintenta llave inválida ni cuota agotada', () => {
    expect(isRetriableHttpFailure(400, googleError('API key not valid'))).toBe(false);
    expect(isRetriableHttpFailure(429, googleError('credits are depleted'))).toBe(false);
    expect(isRetriableHttpFailure(403)).toBe(false);
  });
});

describe('extractApiErrorDetail', () => {
  it('saca el mensaje del sobre de error de Google', () => {
    expect(extractApiErrorDetail(googleError('boom'))).toBe('boom');
  });

  it('cae al cuerpo recortado si no es JSON', () => {
    const long = 'x'.repeat(900);
    expect(extractApiErrorDetail(long)).toHaveLength(500);
  });
});

describe('describeTransportFailure', () => {
  it('reconoce el timeout/abort', () => {
    const error = new Error('aborted');
    error.name = 'AbortError';
    expect(describeTransportFailure(error)).toContain('tardó demasiado');
  });

  it('cae a mensaje de conexión para el resto', () => {
    expect(describeTransportFailure(new Error('ECONNREFUSED'))).toContain('conectar');
    expect(describeTransportFailure(null)).toContain('conectar');
  });
});
