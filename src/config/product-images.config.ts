import { registerAs } from '@nestjs/config';

/**
 * Imágenes de los items del inventario (producto base, presentación y combo).
 *
 * Viven en el MISMO bucket que los respaldos pero en otra carpeta
 * (`inventory_items/`), porque son el mismo proyecto de GCP y la misma
 * identidad: separar buckets obligaría a duplicar permisos y credenciales sin
 * ganar nada. Por eso `bucket` cae por defecto al de respaldos.
 *
 * Sin bucket configurado el módulo queda DESHABILITADO: subir una imagen
 * responde 503 explícito y el resto del inventario sigue funcionando igual
 * (una imagen es un adorno, nunca un bloqueo para vender).
 */
export interface ProductImagesConfig {
  /** Bucket destino. Vacío = subir imágenes deshabilitado. */
  bucket: string;
  /** Carpeta dentro del bucket. Sin barras al inicio ni al final. */
  prefix: string;
  /** Tope de peso del archivo. Se valida en el front Y aquí. */
  maxSizeBytes: number;
  /**
   * Vigencia de la URL firmada que se entrega al cliente.
   *
   * DEBE ser mayor que `cacheTtlSeconds`: una URL sale del caché mucho antes de
   * caducar, así que el navegador nunca recibe un enlace ya vencido.
   */
  signedUrlTtlSeconds: number;
  /**
   * Cuánto vive una URL firmada en el caché en memoria (node-cache).
   *
   * Firmar NO es gratis: con credenciales de la máquina (ADC, que es como corre
   * producción) la firma la hace la API `iam.signBlob` de Google — una llamada
   * de red con cuota. Sin caché, cada refresco del inventario o del POS
   * dispararía una firma POR PRODUCTO.
   */
  cacheTtlSeconds: number;
  /**
   * Días que la imagen sobrevive en el bucket después de archivar el producto.
   *
   * No se borra al instante para que archivar por error sea reversible; pasado
   * el plazo, el cron la elimina y libera el espacio.
   */
  retentionDaysAfterArchive: number;
}

/** 2 MB. Suficiente para una foto de 800×800 px bien comprimida. */
const DEFAULT_MAX_MB = 2;

/**
 * Tope de peso en bytes, leído del entorno.
 *
 * Se exporta como función porque el límite hace falta en DOS sitios: aquí, para
 * la validación de negocio, y en el decorador `FileInterceptor` del controller,
 * que se evalúa al definir la clase y no puede pedirle nada al `ConfigService`.
 * Compartir el origen evita que multer acepte un tamaño distinto del que la
 * action luego rechaza — o, peor, que bufferice en RAM mucho más de lo que el
 * negocio va a admitir.
 */
export function resolveMaxImageSizeBytes(): number {
  const maxMb = Number(process.env.PRODUCT_IMAGE_MAX_MB ?? DEFAULT_MAX_MB);
  const safeMb = Number.isFinite(maxMb) && maxMb > 0 ? maxMb : DEFAULT_MAX_MB;
  return Math.round(safeMb * 1024 * 1024);
}

/**
 * Bucket destino: el propio de imágenes o, si no se declaró, el de respaldos.
 *
 * El fallback usa `||` y no `??` A PROPÓSITO. El esquema de validación declara
 * `GCS_INVENTORY_BUCKET` con default `''`, y `@nestjs/config` escribe ese valor
 * validado de vuelta en `process.env`: con `??` la variable dejaría de ser
 * `undefined` y NUNCA caería al bucket de respaldos, dejando la feature
 * silenciosamente deshabilitada aunque `GCS_BACKUP_BUCKET` estuviera bien
 * configurado. Aquí "vacío" y "sin declarar" significan lo mismo.
 */
/**
 * Entero positivo del entorno, con default. Una variable vacía o basura cae al
 * default en vez de dejar un `NaN` que haría caducar las URLs al instante.
 */
function positiveIntOr(raw: string | undefined, fallback: number): number {
  const parsed = parseInt((raw ?? '').trim(), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function resolveBucket(): string {
  const explicit = (process.env.GCS_INVENTORY_BUCKET ?? '').trim();
  const backups = (process.env.GCS_BACKUP_BUCKET ?? '').trim();
  return explicit || backups;
}

export default registerAs<ProductImagesConfig>('productImages', () => {
  return {
    bucket: resolveBucket(),
    prefix: (process.env.GCS_INVENTORY_PREFIX || 'inventory_items').replace(/^\/+|\/+$/g, ''),
    maxSizeBytes: resolveMaxImageSizeBytes(),
    signedUrlTtlSeconds: positiveIntOr(process.env.PRODUCT_IMAGE_SIGNED_URL_TTL_S, 86400),
    cacheTtlSeconds: positiveIntOr(process.env.PRODUCT_IMAGE_CACHE_TTL_S, 21600),
    retentionDaysAfterArchive: positiveIntOr(process.env.PRODUCT_IMAGE_RETENTION_DAYS, 7),
  };
});
