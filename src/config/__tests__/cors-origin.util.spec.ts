import {
  buildAllowedOrigins,
  isOriginAllowed,
  toOrigin,
  type CorsResolutionInput,
} from '../cors-origin.util';

/**
 * El CORS HTTP de la API decide qué orígenes del navegador pueden llamarla. El
 * regresión concreto que motiva estos tests: la landing (`placepos.kikedevs.com`)
 * sirve el portal de cuenta y llama a la API, pero el `.env` de producción no
 * siempre la lista en `CORS_ORIGINS` → el navegador bloqueaba el login con
 * "Error de CORS". Por eso el origen de la landing (`activationBaseUrl`) debe
 * aceptarse SIEMPRE, con whitelist o sin ella.
 */

const PROD: Pick<CorsResolutionInput, 'isProdLikeEnv'> = { isProdLikeEnv: true };
const DEV: Pick<CorsResolutionInput, 'isProdLikeEnv'> = { isProdLikeEnv: false };

describe('toOrigin', () => {
  it('reduce una base URL con path a su origin puro', () => {
    expect(toOrigin('https://placepos.kikedevs.com/activar')).toBe('https://placepos.kikedevs.com');
  });

  it('conserva un puerto no estándar en el origin', () => {
    expect(toOrigin('http://localhost:5173/algo')).toBe('http://localhost:5173');
  });

  it('normaliza la barra final', () => {
    expect(toOrigin('https://placepos.kikedevs.com/')).toBe('https://placepos.kikedevs.com');
  });

  it('devuelve null para vacío, nullish o URL inválida', () => {
    expect(toOrigin('')).toBeNull();
    expect(toOrigin('   ')).toBeNull();
    expect(toOrigin(undefined)).toBeNull();
    expect(toOrigin(null)).toBeNull();
    expect(toOrigin('no-es-una-url')).toBeNull();
  });
});

describe('buildAllowedOrigins', () => {
  it('une la whitelist con el origen de la landing', () => {
    const origins = buildAllowedOrigins({
      corsOrigins: ['https://erp.kikedevs.com'],
      activationBaseUrl: 'https://placepos.kikedevs.com',
    });
    expect(origins).toContain('https://erp.kikedevs.com');
    expect(origins).toContain('https://placepos.kikedevs.com');
  });

  it('no duplica si la landing ya está en la whitelist', () => {
    const origins = buildAllowedOrigins({
      corsOrigins: ['https://placepos.kikedevs.com', 'https://erp.kikedevs.com'],
      activationBaseUrl: 'https://placepos.kikedevs.com/',
    });
    expect(origins.filter((o) => o === 'https://placepos.kikedevs.com')).toHaveLength(1);
  });

  it('con activationBaseUrl vacío devuelve solo la whitelist', () => {
    expect(
      buildAllowedOrigins({ corsOrigins: ['https://erp.kikedevs.com'], activationBaseUrl: '' }),
    ).toEqual(['https://erp.kikedevs.com']);
  });
});

describe('isOriginAllowed (producción)', () => {
  const base = { corsOrigins: ['https://erp.kikedevs.com'], activationBaseUrl: 'https://placepos.kikedevs.com', ...PROD };

  it('acepta un request sin header Origin (curl / app nativa / same-origin)', () => {
    expect(isOriginAllowed(undefined, base)).toBe(true);
  });

  it('acepta un origen de la whitelist explícita', () => {
    expect(isOriginAllowed('https://erp.kikedevs.com', base)).toBe(true);
  });

  it('acepta la LANDING aunque NO esté en CORS_ORIGINS (el bug reportado)', () => {
    const sinLanding = { corsOrigins: ['https://erp.kikedevs.com'], activationBaseUrl: 'https://placepos.kikedevs.com', ...PROD };
    expect(isOriginAllowed('https://placepos.kikedevs.com', sinLanding)).toBe(true);
  });

  it('rechaza un origen desconocido', () => {
    expect(isOriginAllowed('https://evil.example.com', base)).toBe(false);
  });

  it('rechaza localhost y rangos LAN en producción', () => {
    expect(isOriginAllowed('http://localhost:5173', base)).toBe(false);
    expect(isOriginAllowed('http://192.168.1.50:5180', base)).toBe(false);
  });

  it('distingue esquema/puerto: http no cuela donde la landing es https', () => {
    expect(isOriginAllowed('http://placepos.kikedevs.com', base)).toBe(false);
  });
});

describe('isOriginAllowed (desarrollo)', () => {
  it('acepta localhost y rangos de red privada en cualquier puerto', () => {
    const dev = { corsOrigins: ['http://localhost:5173'], activationBaseUrl: '', ...DEV };
    expect(isOriginAllowed('http://localhost:9999', dev)).toBe(true);
    expect(isOriginAllowed('http://192.168.0.10:5180', dev)).toBe(true);
    expect(isOriginAllowed('http://10.0.0.5:3000', dev)).toBe(true);
    expect(isOriginAllowed('http://172.16.5.4:8080', dev)).toBe(true);
  });

  it('sin whitelist configurada refleja cualquier origen (comportamiento histórico)', () => {
    const dev = { corsOrigins: [], activationBaseUrl: '', ...DEV };
    expect(isOriginAllowed('https://cualquier-cosa.example.com', dev)).toBe(true);
  });

  it('con whitelist configurada sigue rechazando un origen público desconocido', () => {
    const dev = { corsOrigins: ['http://localhost:5173'], activationBaseUrl: '', ...DEV };
    expect(isOriginAllowed('https://evil.example.com', dev)).toBe(false);
  });

  it('un origen 172.32.x.x (fuera del rango privado) no se acepta como LAN', () => {
    const dev = { corsOrigins: ['http://localhost:5173'], activationBaseUrl: '', ...DEV };
    expect(isOriginAllowed('http://172.32.0.1:3000', dev)).toBe(false);
  });
});
