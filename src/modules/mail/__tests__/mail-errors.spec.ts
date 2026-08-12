import {
  describeMailHttpFailure,
  describeMailTransportFailure,
  describeSmtpFailure,
  extractMailErrorDetail,
  isRetriableMailFailure,
  isRetriableSmtpFailure,
} from '../internal/mail-errors';

const resendError = (message: string): string => JSON.stringify({ message, name: 'validation' });

describe('describeMailHttpFailure', () => {
  it('explica 401/403 como llave rechazada', () => {
    expect(describeMailHttpFailure(401)).toContain('RESEND_API_KEY');
    expect(describeMailHttpFailure(403)).toContain('llave de envío');
  });

  it('distingue el dominio sin verificar del resto de 422', () => {
    // Es EL fallo del primer día en producción: sin esto el operador solo ve
    // "datos inválidos" y no sabe que debe tocar el DNS.
    expect(
      describeMailHttpFailure(422, resendError('The kikedevs.com domain is not verified.')),
    ).toContain('dominio del remitente no está verificado');
    expect(describeMailHttpFailure(422, resendError('Invalid `from` field'))).toContain(
      'remitente (MAIL_FROM)',
    );
    expect(describeMailHttpFailure(422, resendError('Invalid `to` recipient'))).toContain(
      'dirección de destino',
    );
    expect(describeMailHttpFailure(422, resendError('algo raro'))).toContain('datos inválidos');
  });

  it('trata el 429 como límite de envíos', () => {
    expect(describeMailHttpFailure(429)).toContain('límite de envíos');
  });

  it('trata los 5xx como caída del proveedor', () => {
    expect(describeMailHttpFailure(500)).toContain('no está disponible');
    expect(describeMailHttpFailure(503)).toContain('no está disponible');
  });

  it('tiene mensaje por defecto para status raros', () => {
    expect(describeMailHttpFailure(418)).toContain('No se pudo enviar');
  });

  it('nunca filtra el cuerpo crudo al usuario', () => {
    const message = describeMailHttpFailure(400, '<html>error interno del proveedor</html>');
    expect(message).not.toContain('<html>');
  });
});

describe('extractMailErrorDetail', () => {
  it('saca el mensaje del cuerpo de Resend', () => {
    expect(extractMailErrorDetail(resendError('domain not verified'))).toBe('domain not verified');
  });

  it('soporta el anidado en error.message', () => {
    expect(extractMailErrorDetail(JSON.stringify({ error: { message: 'anidado' } }))).toBe(
      'anidado',
    );
  });

  it('soporta la lista errors[] de otros proveedores (p. ej. SendGrid)', () => {
    // Es lo que hace intercambiable el módulo: el traductor ya entiende la
    // forma de error de más de un proveedor.
    expect(extractMailErrorDetail(JSON.stringify({ errors: [{ message: 'primero' }] }))).toBe(
      'primero',
    );
  });

  it('cae al cuerpo recortado cuando no hay JSON', () => {
    expect(extractMailErrorDetail('texto plano')).toBe('texto plano');
    expect(extractMailErrorDetail('x'.repeat(600))).toHaveLength(500);
  });

  it('no revienta con JSON válido pero sin mensaje', () => {
    expect(extractMailErrorDetail('{"otra":"cosa"}')).toBe('{"otra":"cosa"}');
    expect(extractMailErrorDetail('null')).toBe('null');
    expect(extractMailErrorDetail('[]')).toBe('[]');
  });
});

describe('isRetriableMailFailure', () => {
  it('reintenta 5xx y 429', () => {
    expect(isRetriableMailFailure(500)).toBe(true);
    expect(isRetriableMailFailure(503)).toBe(true);
    expect(isRetriableMailFailure(429)).toBe(true);
  });

  it('NO reintenta rechazos definitivos', () => {
    // Reintentar una llave inválida o un dominio sin verificar solo retrasa
    // el mismo error.
    for (const status of [400, 401, 403, 404, 422]) {
      expect(isRetriableMailFailure(status)).toBe(false);
    }
  });
});

describe('describeMailTransportFailure', () => {
  it('distingue el timeout del fallo de red', () => {
    expect(describeMailTransportFailure({ name: 'TimeoutError' })).toContain('tardó demasiado');
    expect(describeMailTransportFailure({ name: 'AbortError' })).toContain('tardó demasiado');
    expect(describeMailTransportFailure(new Error('socket hang up'))).toContain(
      'No se pudo conectar',
    );
  });

  it('no revienta con null', () => {
    expect(describeMailTransportFailure(null)).toContain('No se pudo conectar');
  });
});

describe('describeSmtpFailure', () => {
  it('explica el rechazo de credenciales', () => {
    expect(describeSmtpFailure({ code: 'EAUTH' })).toContain('usuario o la contraseña');
    expect(describeSmtpFailure({ responseCode: 535 })).toContain('usuario o la contraseña');
  });

  it('explica el fallo de conexión', () => {
    expect(describeSmtpFailure({ code: 'ECONNECTION' })).toContain('SMTP_HOST');
    expect(describeSmtpFailure({ code: 'ENOTFOUND' })).toContain('SMTP_HOST');
  });

  it('explica el timeout', () => {
    expect(describeSmtpFailure({ code: 'ETIMEDOUT' })).toContain('no respondió a tiempo');
  });

  it('distingue el rechazo definitivo del temporal', () => {
    expect(describeSmtpFailure({ responseCode: 550 })).toContain('definitiva');
    expect(describeSmtpFailure({ responseCode: 451 })).toContain('temporalmente');
  });

  it('reconoce el límite de envíos aunque venga como 5xx', () => {
    // Mailtrap responde `550 5.7.0 Too many emails per second`: por código
    // sería definitivo, pero es justo lo contrario.
    expect(
      describeSmtpFailure({
        responseCode: 550,
        message: 'Data command failed: 550 5.7.0 Too many emails per second.',
      }),
    ).toContain('limitando los envíos');
  });

  it('tiene un mensaje por defecto y no revienta con null', () => {
    expect(describeSmtpFailure({})).toContain('No se pudo enviar');
    expect(describeSmtpFailure(null)).toContain('No se pudo enviar');
  });
});

describe('isRetriableSmtpFailure', () => {
  it('reintenta los fallos de socket y los 4xx de SMTP', () => {
    expect(isRetriableSmtpFailure({ code: 'ETIMEDOUT' })).toBe(true);
    expect(isRetriableSmtpFailure({ code: 'ESOCKET' })).toBe(true);
    expect(isRetriableSmtpFailure({ responseCode: 451 })).toBe(true);
  });

  it('reintenta los límites de tasa aunque lleguen como 5xx', () => {
    // Sin esto se pierde un correo que un reintento habría entregado.
    for (const message of [
      'Data command failed: 550 5.7.0 Too many emails per second.',
      '421 rate limit exceeded',
      '450 Please try again later',
      '452 Too many recipients, throttled',
      '552 quota exceeded',
    ]) {
      expect(isRetriableSmtpFailure({ responseCode: 550, message })).toBe(true);
    }
  });

  it('NO reintenta credenciales malas ni rechazos 5xx definitivos', () => {
    expect(isRetriableSmtpFailure({ code: 'EAUTH', responseCode: 535 })).toBe(false);
    expect(isRetriableSmtpFailure({ responseCode: 550 })).toBe(false);
    expect(isRetriableSmtpFailure({ responseCode: 550, message: 'Mailbox not found' })).toBe(false);
    expect(isRetriableSmtpFailure(null)).toBe(false);
  });
});
