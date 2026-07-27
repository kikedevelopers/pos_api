import { ServiceUnavailableException } from '@nestjs/common';

const storageCtor = jest.fn((_options: Record<string, unknown>) => undefined);
jest.mock('@google-cloud/storage', () => ({
  Storage: class {
    constructor(options: Record<string, unknown>) {
      storageCtor(options);
    }
    bucket(name: string): unknown {
      return { name };
    }
  },
}));

import type { BackupsConfig } from '@/config/backups.config';

import { GcsStorageService } from '../gcs-storage.service';

const BASE: Pick<
  BackupsConfig,
  | 'bucket'
  | 'prefix'
  | 'credentialsJson'
  | 'credentialsFile'
  | 'projectId'
  | 'credentialsMode'
  | 'nodeEnv'
> = {
  bucket: 'placepos-bucket-1',
  prefix: 'backups',
  credentialsJson: '',
  credentialsFile: '',
  projectId: 'proyecto-x',
  credentialsMode: 'auto',
  nodeEnv: 'development',
};

function build(overrides: Partial<typeof BASE> = {}) {
  const config = { ...BASE, ...overrides };
  const configService = { getOrThrow: () => config };
  return new GcsStorageService(configService as never);
}

/** Opciones con las que se construyó el cliente de Storage. */
function ctorOptions(): Record<string, unknown> {
  const [options] = storageCtor.mock.calls[0];
  return options;
}

const SERVICE_ACCOUNT = JSON.stringify({ client_email: 'x@y.iam', private_key: 'k' });

describe('GcsStorageService · origen de las credenciales', () => {
  beforeEach(() => storageCtor.mockReset());

  it('en desarrollo usa el archivo local', () => {
    build({ credentialsFile: '/ruta/clave.json' }).getBucket();

    expect(ctorOptions().keyFilename).toBe('/ruta/clave.json');
  });

  it('en desarrollo prefiere el JSON en línea sobre el archivo', () => {
    build({ credentialsJson: SERVICE_ACCOUNT, credentialsFile: '/ruta/clave.json' }).getBucket();

    expect(ctorOptions().credentials).toEqual({ client_email: 'x@y.iam', private_key: 'k' });
    expect(ctorOptions().keyFilename).toBeUndefined();
  });

  it('en PRODUCCIÓN ignora el archivo local y usa la identidad de la máquina', () => {
    build({ nodeEnv: 'production', credentialsFile: '/ruta/clave.json' }).getBucket();

    expect(ctorOptions().keyFilename).toBeUndefined();
    expect(ctorOptions().credentials).toBeUndefined();
  });

  it('en PRODUCCIÓN tampoco usa el JSON en línea con modo auto', () => {
    build({ nodeEnv: 'production', credentialsJson: SERVICE_ACCOUNT }).getBucket();

    expect(ctorOptions().credentials).toBeUndefined();
  });

  it('modo file fuerza el archivo aunque sea producción', () => {
    build({
      nodeEnv: 'production',
      credentialsMode: 'file',
      credentialsFile: '/ruta/clave.json',
    }).getBucket();

    expect(ctorOptions().keyFilename).toBe('/ruta/clave.json');
  });

  it('modo json fuerza el JSON aunque sea producción', () => {
    build({
      nodeEnv: 'production',
      credentialsMode: 'json',
      credentialsJson: SERVICE_ACCOUNT,
    }).getBucket();

    expect(ctorOptions().credentials).toEqual({ client_email: 'x@y.iam', private_key: 'k' });
  });

  it('modo adc ignora las credenciales locales en desarrollo', () => {
    build({ credentialsMode: 'adc', credentialsFile: '/ruta/clave.json' }).getBucket();

    expect(ctorOptions().keyFilename).toBeUndefined();
  });

  it('sin credenciales en desarrollo cae a las del entorno', () => {
    build().getBucket();

    expect(ctorOptions().keyFilename).toBeUndefined();
    expect(ctorOptions().credentials).toBeUndefined();
  });

  it('pasa el projectId cuando está configurado', () => {
    build().getBucket();

    expect(ctorOptions().projectId).toBe('proyecto-x');
  });

  it('modo file sin archivo configurado falla con un mensaje claro', () => {
    expect(() => build({ credentialsMode: 'file' }).getBucket()).toThrow(
      /GCS_CREDENTIALS_FILE está vacío/,
    );
  });

  it('modo json sin JSON configurado falla con un mensaje claro', () => {
    expect(() => build({ credentialsMode: 'json' }).getBucket()).toThrow(
      /GCS_CREDENTIALS_JSON está vacío/,
    );
  });

  it('un JSON corrupto no arranca el cliente', () => {
    expect(() => build({ credentialsJson: '{no-es-json' }).getBucket()).toThrow(
      /no es un JSON válido/,
    );
  });

  it('sin bucket el módulo está deshabilitado', () => {
    const service = build({ bucket: '' });

    expect(service.isConfigured).toBe(false);
    expect(() => service.getBucket()).toThrow(ServiceUnavailableException);
  });

  it('el cliente se construye una sola vez', () => {
    const service = build({ credentialsFile: '/ruta/clave.json' });
    service.getBucket();
    service.getBucket();

    expect(storageCtor).toHaveBeenCalledTimes(1);
  });
});
