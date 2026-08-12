import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import appConfig, { type AppConfig } from '@/config/app.config';

/**
 * `ACTIVATION_BASE_URL` es la base de los enlaces que salen por correo
 * (activación y recuperación de contraseña). Apuntarla al servidor equivocado
 * manda al cliente a una página que no existe — y el fallo NO se ve en ningún
 * test de unidad: el correo sale, el enlace se genera, y solo revienta cuando
 * una persona lo abre.
 *
 * En desarrollo el error fácil es poner 5173, que es el dev server del RENDERER
 * de placepos, no el de la landing (5181). React Router responde entonces
 * "No routes matched /restablecer" y el usuario ve una pantalla en blanco.
 */

/** Puerto del dev server del renderer de placepos: NUNCA sirve las páginas. */
const PLACEPOS_RENDERER_DEV_PORT = '5173';

const readEnvExample = (): string => readFileSync(join(process.cwd(), '.env.example'), 'utf8');

/** `registerAs` envuelve el tipo; se acota para poder leer las propiedades. */
const load = (): AppConfig => appConfig() as unknown as AppConfig;

const valueOf = (content: string, key: string): string => {
  const line = content.split('\n').find((l) => l.startsWith(`${key}=`));
  return line ? line.slice(key.length + 1).trim() : '';
};

describe('ACTIVATION_BASE_URL', () => {
  const original = process.env.ACTIVATION_BASE_URL;

  afterEach(() => {
    if (original === undefined) {
      delete process.env.ACTIVATION_BASE_URL;
    } else {
      process.env.ACTIVATION_BASE_URL = original;
    }
  });

  it('sin configurar apunta a la landing de producción', () => {
    delete process.env.ACTIVATION_BASE_URL;
    expect(load().activationBaseUrl).toBe('https://placepos.kikedevs.com');
  });

  it('quita la barra final para no generar enlaces con doble barra', () => {
    process.env.ACTIVATION_BASE_URL = 'http://localhost:5181///';
    expect(load().activationBaseUrl).toBe('http://localhost:5181');
  });

  it('el .env.example NO apunta al dev server del renderer de placepos', () => {
    // Ahí vive React Router, que responde "No routes matched /restablecer".
    const value = valueOf(readEnvExample(), 'ACTIVATION_BASE_URL');
    expect(value).not.toContain(`:${PLACEPOS_RENDERER_DEV_PORT}`);
  });

  it('el CORS de ejemplo incluye el origen de la landing', () => {
    // La página de activación llama a /auth/activate desde el navegador: sin
    // su origen en la lista, el navegador bloquea el canje.
    const example = readEnvExample();
    const base = valueOf(example, 'ACTIVATION_BASE_URL');
    const cors = valueOf(example, 'CORS_ORIGINS');
    expect(cors.split(',').map((o) => o.trim())).toContain(base);
  });
});
