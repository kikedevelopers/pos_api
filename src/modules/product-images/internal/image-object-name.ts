import { randomBytes } from 'node:crypto';

/**
 * Ruta del objeto dentro del bucket:
 *
 *   `inventory_items/<company_id>/<product_id>-<aleatorio>.<ext>`
 *
 * Tres decisiones:
 *
 *   - Carpeta por company: al mirar el bucket se ve de quién es cada archivo, y
 *     un borrado masivo por tenant es un prefijo, no una lista de rutas.
 *   - `product_id` al frente: buscar la imagen de un producto en la consola de
 *     GCS es teclear el id, sin cruzar contra la BD.
 *   - Sufijo aleatorio: al REEMPLAZAR una imagen la ruta cambia, así que el
 *     navegador (y cualquier CDN de por medio) no puede servir la vieja desde
 *     su caché. La anterior se borra en el mismo flujo, así que no acumula.
 */
export function buildImageObjectName(params: {
  prefix: string;
  companyId: number;
  productId: number;
  extension: string;
}): string {
  const { prefix, companyId, productId, extension } = params;
  const suffix = randomBytes(8).toString('hex');
  const folder = prefix.replace(/^\/+|\/+$/g, '');
  return `${folder}/${companyId}/${productId}-${suffix}.${extension}`;
}

/**
 * ¿La ruta guardada pertenece a esta company?
 *
 * `products.image` es una ruta que escribe SOLO el servidor, pero borrar en el
 * bucket a partir de un dato de la BD merece un cinturón de seguridad: si por
 * un dump mal importado una fila apuntara a la carpeta de otro tenant, el
 * borrado se salta en vez de tocar un archivo ajeno.
 */
export function isObjectOwnedByCompany(
  objectName: string,
  prefix: string,
  companyId: number,
): boolean {
  const folder = prefix.replace(/^\/+|\/+$/g, '');
  return objectName.startsWith(`${folder}/${companyId}/`);
}
