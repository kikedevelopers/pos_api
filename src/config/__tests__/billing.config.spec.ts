import { resolveBillingConfig, validateWompiKeys, WOMPI_API_BASE_URLS } from '../billing.config';

describe('billing.config — llaves de Wompi por ambiente', () => {
  it('sandbox con llaves de prueba: configurado y apunta a sandbox', () => {
    const config = resolveBillingConfig({
      WOMPI_PRIVATE_KEY: 'prv_test_abc',
      WOMPI_EVENTS_SECRET: 'test_events_xyz',
    });
    expect(config.environment).toBe('sandbox');
    expect(config.apiBaseUrl).toBe(WOMPI_API_BASE_URLS.sandbox);
    expect(config.configured).toBe(true);
    expect(config.configurationError).toBe('');
  });

  it('producción con llaves de producción: configurado y apunta a producción', () => {
    const config = resolveBillingConfig({
      WOMPI_ENVIRONMENT: 'production',
      WOMPI_PRIVATE_KEY: 'prv_prod_abc',
      WOMPI_EVENTS_SECRET: 'prod_events_xyz',
    });
    expect(config.apiBaseUrl).toBe('https://production.wompi.co/v1');
    expect(config.configured).toBe(true);
  });

  it('producción con llave de PRUEBAS: deshabilitado (nunca cobra contra el ambiente equivocado)', () => {
    const config = resolveBillingConfig({
      WOMPI_ENVIRONMENT: 'production',
      WOMPI_PRIVATE_KEY: 'prv_test_abc',
      WOMPI_EVENTS_SECRET: 'prod_events_xyz',
    });
    expect(config.configured).toBe(false);
    expect(config.configurationError).toMatch(/prv_prod_/);
  });

  it('secreto de eventos de otro ambiente: deshabilitado', () => {
    expect(validateWompiKeys('sandbox', 'prv_test_a', 'prod_events_b')).toMatch(/test_events_/);
  });

  it('sin llaves: deshabilitado con el motivo', () => {
    expect(validateWompiKeys('sandbox', '', 'test_events_b')).toMatch(/WOMPI_PRIVATE_KEY/);
    expect(validateWompiKeys('sandbox', 'prv_test_a', '')).toMatch(/WOMPI_EVENTS_SECRET/);
    expect(resolveBillingConfig({}).configured).toBe(false);
  });

  it('un ambiente desconocido cae en sandbox (nunca en producción por accidente)', () => {
    expect(resolveBillingConfig({ WOMPI_ENVIRONMENT: 'prod' }).environment).toBe('sandbox');
  });

  it('URL de regreso: BILLING_RETURN_URL > ACTIVATION_BASE_URL > landing, sin barra final', () => {
    expect(resolveBillingConfig({ BILLING_RETURN_URL: 'http://x.test/' }).returnUrl).toBe(
      'http://x.test',
    );
    expect(resolveBillingConfig({ ACTIVATION_BASE_URL: 'http://y.test' }).returnUrl).toBe(
      'http://y.test',
    );
    expect(resolveBillingConfig({}).returnUrl).toBe('https://placepos.kikedevs.com');
  });

  it('correos de alerta: lista separada por comas, sin vacíos', () => {
    expect(resolveBillingConfig({ BILLING_ALERT_EMAILS: ' a@x.co, ,b@y.co ' }).alertEmails).toEqual(
      ['a@x.co', 'b@y.co'],
    );
  });

  it('el barrido viene encendido salvo "false" explícito', () => {
    expect(resolveBillingConfig({}).reconcileEnabled).toBe(true);
    expect(resolveBillingConfig({ BILLING_RECONCILE_ENABLED: 'false' }).reconcileEnabled).toBe(
      false,
    );
  });
});
