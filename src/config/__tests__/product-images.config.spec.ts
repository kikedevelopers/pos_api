import productImagesConfig, {
  resolveMaxImageSizeBytes,
  type ProductImagesConfig,
} from '../product-images.config';

/**
 * El tope de peso se lee del entorno en DOS sitios: la validación de negocio y
 * el `limits.fileSize` de multer en el controller (que se evalúa al definir la
 * clase y no puede usar el `ConfigService`).
 *
 * Que salgan del MISMO origen no es cosmética: multer bufferiza el archivo en
 * MEMORIA antes de que corra ninguna validación, así que un techo más alto que
 * el límite real es memoria que el API retiene para después rechazar la
 * petición.
 */

const TOUCHED = [
  'PRODUCT_IMAGE_MAX_MB',
  'GCS_INVENTORY_BUCKET',
  'GCS_BACKUP_BUCKET',
  'GCS_INVENTORY_PREFIX',
  'PRODUCT_IMAGE_SIGNED_URL_TTL_S',
  'PRODUCT_IMAGE_CACHE_TTL_S',
  'PRODUCT_IMAGE_RETENTION_DAYS',
] as const;

const ORIGINAL = Object.fromEntries(TOUCHED.map((key) => [key, process.env[key]]));

afterEach(() => {
  for (const key of TOUCHED) {
    const value = ORIGINAL[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
});

/**
 * Config ya resuelta, como la ve el servicio. `registerAs` tipa el retorno como
 * posiblemente asíncrono; esta factory es síncrona, así que se acota.
 */
function buildConfig(): ProductImagesConfig {
  return productImagesConfig() as ProductImagesConfig;
}

describe('resolveMaxImageSizeBytes', () => {
  it('por defecto son 2 MB', () => {
    delete process.env.PRODUCT_IMAGE_MAX_MB;
    expect(resolveMaxImageSizeBytes()).toBe(2 * 1024 * 1024);
  });

  it('respeta el valor del entorno', () => {
    process.env.PRODUCT_IMAGE_MAX_MB = '5';
    expect(resolveMaxImageSizeBytes()).toBe(5 * 1024 * 1024);
  });

  it('admite decimales', () => {
    process.env.PRODUCT_IMAGE_MAX_MB = '1.5';
    expect(resolveMaxImageSizeBytes()).toBe(Math.round(1.5 * 1024 * 1024));
  });

  it('un valor no numérico cae al default en vez de dejar el límite en NaN', () => {
    process.env.PRODUCT_IMAGE_MAX_MB = 'muchos';
    expect(resolveMaxImageSizeBytes()).toBe(2 * 1024 * 1024);
  });

  it('cero o negativo caen al default (un límite de 0 rechazaría todo)', () => {
    process.env.PRODUCT_IMAGE_MAX_MB = '0';
    expect(resolveMaxImageSizeBytes()).toBe(2 * 1024 * 1024);
    process.env.PRODUCT_IMAGE_MAX_MB = '-3';
    expect(resolveMaxImageSizeBytes()).toBe(2 * 1024 * 1024);
  });

  it('el techo de multer del controller se queda pegado al límite de negocio', async () => {
    // Documenta la relación: lo que el API llega a retener en RAM por petición
    // es el límite real + un margen mínimo, NO un techo holgado.
    process.env.PRODUCT_IMAGE_MAX_MB = '2';
    const { ProductsController } = await import('@/modules/products/products.controller');
    const ceiling = (ProductsController as unknown as { MULTER_IMAGE_CEILING_BYTES: number })
      .MULTER_IMAGE_CEILING_BYTES;

    expect(ceiling).toBeGreaterThan(resolveMaxImageSizeBytes());
    expect(ceiling - resolveMaxImageSizeBytes()).toBeLessThanOrEqual(64 * 1024);
  });
});

/**
 * El bucket decide si la feature existe: sin él, `image-settings` responde
 * `enabled: false` y el formulario NO pinta el campo de imagen. Estos casos
 * cubren la trampa que lo tuvo deshabilitado en local: el esquema de validación
 * declara `GCS_INVENTORY_BUCKET` con default `''` y `@nestjs/config` escribe ese
 * valor de vuelta en `process.env`, así que un fallback con `??` jamás llegaría
 * al bucket de respaldos.
 */
describe('bucket · fallback al de respaldos', () => {
  it('usa el bucket propio de imágenes cuando está declarado', () => {
    process.env.GCS_INVENTORY_BUCKET = 'bucket-imagenes';
    process.env.GCS_BACKUP_BUCKET = 'bucket-respaldos';

    expect(buildConfig().bucket).toBe('bucket-imagenes');
  });

  it('con la variable propia VACÍA cae al bucket de respaldos', () => {
    // Este es el caso real: Joi rellena la variable con '' y `??` no lo detecta.
    process.env.GCS_INVENTORY_BUCKET = '';
    process.env.GCS_BACKUP_BUCKET = 'placepos-bucket-1';

    expect(buildConfig().bucket).toBe('placepos-bucket-1');
  });

  it('con la variable propia sin declarar cae al bucket de respaldos', () => {
    delete process.env.GCS_INVENTORY_BUCKET;
    process.env.GCS_BACKUP_BUCKET = 'placepos-bucket-1';

    expect(buildConfig().bucket).toBe('placepos-bucket-1');
  });

  it('ignora los espacios de una variable mal pegada', () => {
    process.env.GCS_INVENTORY_BUCKET = '   ';
    process.env.GCS_BACKUP_BUCKET = 'placepos-bucket-1';

    expect(buildConfig().bucket).toBe('placepos-bucket-1');
  });

  it('sin ningún bucket queda vacío (feature deshabilitada, sin romper el arranque)', () => {
    process.env.GCS_INVENTORY_BUCKET = '';
    process.env.GCS_BACKUP_BUCKET = '';

    expect(buildConfig().bucket).toBe('');
  });
});

describe('resto de la configuración', () => {
  it('el prefijo vacío cae al default en vez de dejar rutas sin carpeta', () => {
    process.env.GCS_INVENTORY_PREFIX = '';
    expect(buildConfig().prefix).toBe('inventory_items');
  });

  it('normaliza el prefijo con barras sobrantes', () => {
    process.env.GCS_INVENTORY_PREFIX = '/fotos/';
    expect(buildConfig().prefix).toBe('fotos');
  });

  it('los TTL vacíos caen al default en vez de quedar en NaN', () => {
    // Un NaN aquí haría que las URLs firmadas caducaran al instante.
    process.env.PRODUCT_IMAGE_SIGNED_URL_TTL_S = '';
    process.env.PRODUCT_IMAGE_CACHE_TTL_S = '';
    process.env.PRODUCT_IMAGE_RETENTION_DAYS = '';

    const config = buildConfig();

    expect(config.signedUrlTtlSeconds).toBe(86400);
    expect(config.cacheTtlSeconds).toBe(21600);
    expect(config.retentionDaysAfterArchive).toBe(7);
  });

  it('respeta los TTL del entorno cuando son válidos', () => {
    process.env.PRODUCT_IMAGE_SIGNED_URL_TTL_S = '3600';
    process.env.PRODUCT_IMAGE_RETENTION_DAYS = '15';

    const config = buildConfig();

    expect(config.signedUrlTtlSeconds).toBe(3600);
    expect(config.retentionDaysAfterArchive).toBe(15);
  });
});
