import { validationSchema } from '@/config/validation.schema';

/**
 * El esquema Joi corre al arrancar la app: si rechaza una variable, el servidor
 * NO levanta. Estos tests cubren el bloque de correo, y sobre todo garantizan
 * que el `.env.example` tal cual se puede copiar sin tumbar el arranque.
 */

/** Variables mínimas para que el esquema valide (las obligatorias de la app). */
const BASE_ENV = {
  DB_HOST: 'localhost',
  DB_USERNAME: 'postgres',
  DB_PASSWORD: '',
  DB_NAME: 'pos_db',
  JWT_SECRET: 'x'.repeat(64),
};

const validate = (
  mailEnv: Record<string, string>,
): { error?: { message: string }; value: Record<string, unknown> } =>
  validationSchema.validate({ ...BASE_ENV, ...mailEnv }, { allowUnknown: true, abortEarly: false });

describe('validación del entorno — bloque de correo', () => {
  it('acepta el bloque tal cual viene en el .env.example (todo vacío)', () => {
    // Los valores vacíos son la configuración documentada por defecto: si el
    // esquema los rechaza, copiar el ejemplo impide arrancar el servidor.
    const { error } = validate({
      MAIL_DRIVER: '',
      MAIL_FROM: 'PlacePOS <no-reply@kikedevs.com>',
      MAIL_REPLY_TO: '',
      MAIL_TIMEOUT_MS: '15000',
      RESEND_API_KEY: '',
      RESEND_BASE_URL: 'https://api.resend.com',
      SMTP_HOST: '',
      SMTP_PORT: '2525',
      SMTP_USERNAME: '',
      SMTP_PASSWORD: '',
      SMTP_SECURE: '',
    });
    expect(error).toBeUndefined();
  });

  it('acepta que no se declare NINGUNA variable de correo', () => {
    expect(validate({}).error).toBeUndefined();
  });

  it('acepta los drivers soportados y rechaza el resto', () => {
    for (const driver of ['resend', 'smtp', 'log', '']) {
      expect(validate({ MAIL_DRIVER: driver }).error).toBeUndefined();
    }
    expect(validate({ MAIL_DRIVER: 'sendgrid' }).error?.message).toContain('MAIL_DRIVER');
  });

  it('acepta SMTP_SECURE explícito en ambas formas', () => {
    for (const value of ['true', 'false']) {
      expect(validate({ SMTP_SECURE: value }).error).toBeUndefined();
    }
    expect(validate({ SMTP_SECURE: 'quizás' }).error?.message).toContain('SMTP_SECURE');
  });

  it('rechaza puertos y tiempos fuera de rango', () => {
    expect(validate({ SMTP_PORT: '0' }).error?.message).toContain('SMTP_PORT');
    expect(validate({ SMTP_PORT: '70000' }).error?.message).toContain('SMTP_PORT');
    expect(validate({ MAIL_TIMEOUT_MS: '10' }).error?.message).toContain('MAIL_TIMEOUT_MS');
    expect(validate({ MAIL_TIMEOUT_MS: '999999' }).error?.message).toContain('MAIL_TIMEOUT_MS');
  });

  it('aplica los valores por defecto cuando no se declaran', () => {
    const { value } = validate({});
    expect(value.MAIL_DRIVER).toBe('');
    expect(value.MAIL_TIMEOUT_MS).toBe(15000);
    expect(value.SMTP_PORT).toBe(2525);
    expect(value.RESEND_BASE_URL).toBe('https://api.resend.com');
  });
});
